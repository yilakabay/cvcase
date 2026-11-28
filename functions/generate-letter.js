// functions/generate-letter.js
// POST body: { userId, sessionToken, fullName, phone, email, address, appDate, cvText,
//              jdText, jdUrl, targetPosition, extraPrompt }
//
// Writes the application letter with Claude 5.5 Sonnet (via the B.AI gateway)
// and charges the user's CT balance for the REAL tokens it used
// (see lib/ai-billing.js).
//
// Response on success: { letterText, tokensUsed, tokenBalance }
// Response when the user can't afford it: 402 { error, code:'INSUFFICIENT_TOKENS', tokenBalance }

const https = require('https');
const http  = require('http');
const { runBilledChat, getDb, authenticate, errorResponse, AIError } = require('./lib/ai-billing');

// ── Fetch plain text from a URL ───────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CVerveBot/1.0)' } }, res => {
      // Follow one redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch URL: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('URL fetch timed out after 15 seconds.')); });
    req.on('error', reject);
  });
}

// ── Structural variety, picked per request ────────────────────────────────────
// Root cause of "every CVcase letter reads like the same person/tool wrote it":
// the old prompt told the model, in its STRICT GUIDELINES, to literally open
// paragraph 1 by "stating the position you are applying for" — so almost
// every letter started "I'm applying for the X role because...". It also
// offered "What drew me to this role is..." as an EXAMPLE transitional
// phrase, and the model took that as the answer rather than one option, so
// it appeared near-verbatim in letter after letter, for every user, right
// before an equally uniform "I'm available for an interview at
// [whatever/any] time that suits you" closing line. Two users' letters
// (or two letters for the same user, different jobs) ended up reading as
// obviously AI-generated from the same template, which defeats the point.
//
// Fixed by picking ONE opening strategy and ONE closing strategy at random,
// in code, per request — not left to the model's own (mode-seeking, so not
// actually random) judgment — and by explicitly banning the exact phrases
// that showed up as repeat offenders.
// User feedback (2026-11-28): the earlier narrative/CV-anecdote-first
// openers ("Within 30 days of joining Anbesa Bank, I was running...")
// were rejected outright — every letter must open with a direct, explicit
// statement of intent (name, or "applying"/"writing to apply"), never a
// CV story as the very first sentence. Variety now comes only from WHICH
// direct opening shape is picked, not from how indirectly it's approached.
const OPENING_STRATEGIES = [
  'Open paragraph 1 directly and plainly with a sentence shaped like "I am applying for the [position] position because...", followed immediately by one concrete, specific reason drawn from the CV — keep this one plain and direct, not flowery.',
  'Open paragraph 1 with a sentence shaped like "I am writing to apply for the [position] role...", then move straight into one concrete fact from the CV that makes the applicant a fit.',
  'Open paragraph 1 by introducing the applicant by name first — a sentence shaped like "My name is [Applicant Name], and I am applying for..." — before anything else, then one concrete supporting fact.',
  'Open paragraph 1 with a sentence shaped like "I would like to apply for the [position] position..." then immediately give one concrete, specific reason drawn from the CV.',
  'Open paragraph 1 with a sentence shaped like "I am excited to submit my application for the [position] position..." then one concrete supporting fact from the CV — confident in tone, not deferential or pleading.',
  'Open paragraph 1 with a sentence shaped like "I am reaching out to apply for the [position] position..." then one concrete supporting fact from the CV.'
];
const CLOSING_STRATEGIES = [
  'Close paragraph 3 by tying genuine interest back to one specific, concrete detail from the job description (not generic enthusiasm), then a short, differently-worded sentence about being glad to discuss further — never the construction "I am available for an interview at [whatever/any] time that suits you."',
  'Close paragraph 3 with a brief, confident sentence about what the applicant would focus on in the role\'s first few months, then a short closing line inviting a conversation, worded naturally and differently each time.',
  'Close paragraph 3 with one honest sentence about why this specific opportunity stands out, then end with a short, varied invitation to talk further (e.g. naming a specific next step, or simply that you\'d welcome the chance to discuss it) — avoid stock phrasing about being "available at your convenience."',
  'Close paragraph 3 by stating plainly what interests the applicant about this particular team or mission, then a brief, naturally-worded closing sentence that avoids the word "convenience" or "whatever time suits."'
];
// Sign-off right before the applicant's name — "Sincerely," every single
// time is its own small fingerprint, so pick one valediction at random
// per request too, same reasoning as the opening/closing strategies above.
const SIGN_OFFS = ['Sincerely,', 'Best regards,', 'Kind regards,', 'Yours faithfully,', 'Respectfully,', 'Warm regards,'];
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Strip HTML tags and collapse whitespace ───────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let parsedBody;
  try { parsedBody = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { userId, sessionToken, fullName, phone, email, address, appDate, cvText, jdText, jdUrl, targetPosition, extraPrompt } = parsedBody;

  if (!process.env.BAI_API_KEY) {
    console.error('generate-letter: Missing BAI_API_KEY');
    return { statusCode: 500, body: JSON.stringify({ error: 'We are unable to generate your letter right now. Please try again in a moment.' }) };
  }

  if (!targetPosition || targetPosition.trim().length < 2) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please specify the position you are applying for.' }) };
  }

  try {
    // Log-in check FIRST — before we download any URL or spend anything.
    const db   = await getDb();
    const user = await authenticate(db, userId, sessionToken);

    if (!cvText || cvText.length < 20) {
      return { statusCode: 400, body: JSON.stringify({ error: 'CV text is required and must contain sufficient content' }) };
    }

    // ── Resolve JD text ───────────────────────────────────────────────────────
    let resolvedJdText = jdText || '';

    if (jdUrl && (!jdText || jdText.length < 20)) {
      console.log('Fetching JD from URL:', jdUrl);
      try {
        const rawHtml = await fetchUrl(jdUrl);
        resolvedJdText = htmlToText(rawHtml);
        console.log(`Fetched ${resolvedJdText.length} chars from URL`);
      } catch (fetchErr) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Could not fetch the job description URL: ${fetchErr.message}` })
        };
      }
    }

    if (!resolvedJdText || resolvedJdText.length < 20) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Job description text is required and must contain sufficient content' }) };
    }

    console.log("CV Text Length:", cvText.length);
    console.log("JD Text Length:", resolvedJdText.length);
    console.log("Target Position:", targetPosition);
    console.log("Extra Prompt Provided:", !!(extraPrompt && extraPrompt.trim()));

    // Kept modest on purpose: users pay per token, and a letter never needs more
    // than this much of a CV or a job post (a long web page can be huge).
    const MAX_TEXT_LENGTH = 15000;
    const truncatedJdText = resolvedJdText.length > MAX_TEXT_LENGTH
      ? resolvedJdText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : resolvedJdText;
    const truncatedCvText = cvText.length > MAX_TEXT_LENGTH
      ? cvText.substring(0, MAX_TEXT_LENGTH) + '... [truncated]'
      : cvText;

    // Extra, user-supplied instructions are optional and bounded in length so a
    // very long paste can't blow out the prompt or override the core structure.
    const MAX_EXTRA_PROMPT_LENGTH = 1500;
    let sanitizedExtraPrompt = '';
    if (extraPrompt && typeof extraPrompt === 'string' && extraPrompt.trim()) {
      sanitizedExtraPrompt = extraPrompt.trim().substring(0, MAX_EXTRA_PROMPT_LENGTH);
    }

    const chosenOpening = pickRandom(OPENING_STRATEGIES);
    const chosenClosing = pickRandom(CLOSING_STRATEGIES);
    const chosenSignOff = pickRandom(SIGN_OFFS);

    // app.html sends targetPosition as "<title> at <company>" (see its
    // jobLetterGenerate flow) so the model above can tell apart same-titled
    // roles at different companies when the JD source lists several
    // postings. That's useful for the POSITION FILTERING instruction, but
    // the subject line already gets the company name on its own separate
    // line right above it (STRICT GUIDELINES item 3), so repeating
    // "at <company>" in the subject too was pure duplication — strip it
    // there and use the bare title only.
    const subjectPosition = targetPosition.replace(/\s+at\s+.+$/i, '').trim() || targetPosition;

    const prompt = `
      TARGET POSITION: "${targetPosition}"

      JOB DESCRIPTION SOURCE:
      ${truncatedJdText}

      APPLICANT'S CV:
      ${truncatedCvText}

      APPLICANT INFORMATION:
      - Name: ${fullName}
      - Phone: ${phone}
      - Email: ${email}
      - Address: ${address}
      - Date: ${appDate}

      INSTRUCTIONS:
      Write a short, genuine application letter for the EXACT position: "${targetPosition}".

      CRITICAL — POSITION FILTERING:
      The job description source above may contain multiple job openings or positions. You MUST focus ONLY on the role titled "${targetPosition}" and its associated requirements, responsibilities, and company context. Completely ignore any other job postings, roles, or positions mentioned in the text. If the exact title is not found, use the closest matching role and any general company/department information provided. Do NOT write a letter for any other position.

      STRICT GUIDELINES:
      1. Total body length: exactly 3 paragraphs. Each paragraph is 2-3 sentences maximum, no more — every sentence must earn its place; cut anything that doesn't directly support the fit, the skill match, or the close. The entire letter body must fit in roughly HALF an A4 page, not two thirds — short and on-target, not padded.
      2. Header block (no labels): Name, Phone, Email, Address, Date — each on its own line. This is the ONLY place phone and email should appear in the entire letter.
      3. Then the company name on its own line, by itself — extracted from the job description source. If the company name genuinely cannot be determined from the source, omit this line entirely rather than guessing.
      4. Then, on the next line, a subject line in EXACTLY this format: "Subject: Application for the position of ${subjectPosition}" — the literal word "Subject:" must be the first word of this line so it reads as a real subject line, not just another line of text. Do NOT include the company name here (even if it's part of the target position given below) — it already appears on its own line directly above. Do not vary this wording or drop the "Subject:" label, even to sound less formal — this one line is a fixed business-letter convention, not part of the warm/first-person voice described below.
      5. Then "Dear Hiring Manager" (or recipient name if given in the JD).
      5b. CRITICAL: Paragraph 1's very first sentence must be a direct, plain statement of intent to apply (one of the opening approaches below) — never a CV anecdote, a workplace story, or any other scene-setting detail (e.g. never "Within 30 days of joining X, I was running..." as the opening sentence). The concrete CV fact/skill can and should follow right after, but the first sentence always announces who's writing and that they're applying for this specific role.
      6. Paragraph 1: establish fit for "${targetPosition}", drawn directly from the CV and the role's requirements, factual and concrete, not generic — but follow this exact opening approach for THIS letter, and no other: ${chosenOpening}
      7. Paragraph 2: Highlight one or two concrete skills or experiences from the CV that directly match the job requirements. Be specific about what you did and how it relates to this role.
      8. Paragraph 3: Express genuine interest in the company/role, then close with availability for interview — but follow this exact closing approach for THIS letter, and no other: ${chosenClosing} Do NOT include phone number or email here — they are already in the header.
      9. Close with "${chosenSignOff}" then the applicant's name, on its own line below. Use this exact sign-off for THIS letter, and no other — do not substitute "Sincerely," or any other valediction.
      10. No bullet points, no bold text, no em dashes, no placeholders.
      11. Only mention GPA if it is 3.0 or above; omit the "/4.0" scale.
      12. Do not mention attaching documents.
      13. CRITICAL: Phone number and email must appear ONLY in the header block (item 2 above). Do NOT repeat them anywhere in the body paragraphs or closing. The closing sentence should only mention availability for an interview, NOT contact details.

      VOICE — SOUND LIKE A REAL PERSON, NOT AN AI OR AN HR TEMPLATE:
      Act like a seasoned, empathetic ghostwriter, not an HR bot or a LinkedIn-influencer voice. Write in a warm, confident, first-person voice — like a thoughtful professional explaining themselves over coffee, not a keyword list.
      - Vary sentence length on purpose within each paragraph: mix one short, punchy sentence with one longer, more detailed one. It's fine, occasionally, to start a sentence with "And," "But," or "So" if it reads naturally — don't force it into every paragraph.
      - Invent your own connective phrasing for this letter rather than leaning on any fixed phrase — vary it every time so two different letters never share the same transition.
      - Don't just list the CV — narrate it in miniature: what you did, why it mattered, what the result was. One concrete detail beats three vague claims.
      - Direct opener phrases like "I am applying for the [position] position because," "I am writing to apply for," and "My name is [Name], and I am applying for" belong ONLY in that first sentence of paragraph 1, exactly as the opening approach below specifies — never reuse them again later in the letter.
      - The opener must sound confident and direct, never deferential or pleading — avoid phrasing like "Please accept this letter as my application," "I humbly request," "I would be grateful if you would consider," or anything else that reads as begging rather than a plain, professional statement of intent.
      - BANNED EVERYWHERE — never use these, or anything that reads as the same construction with different words, anywhere in the letter: "I am a hard-working team player," "In my previous role, I was responsible for," "What drew me to this role is," "I found myself drawn to," "I am available for an interview at whatever/any time that suits you," "I am confident," "leverage my skills," "dynamic team," "excited to apply." These phrases have already shown up across multiple different applicants' letters from this same writer, which is exactly what must never happen again — every letter has to sound like it came from a different person who has never seen the others. Prefer specific, active verbs (led, untangled, rebuilt, championed) over generic ones (managed, did, worked, handled) — but don't force an unusual verb where a plain one is clearer; it should still sound like something a person would actually say, not a thesaurus.
      - The result should read as if a sharp, slightly informal professional wrote it in one sitting: polished enough to send, natural enough that no two letters sound alike.
      - None of the above overrides the STRICT GUIDELINES above — the paragraph count, header format, and phone/email placement rules always win over stylistic choices.
      ${sanitizedExtraPrompt ? `
      ADDITIONAL APPLICANT INSTRUCTIONS (apply these on top of the rules above; if anything here conflicts with the STRICT GUIDELINES or the header/body structure, the STRICT GUIDELINES win):
      "${sanitizedExtraPrompt}"
      ` : ''}

      Generate the letter now:
    `;

    // Ask the model, then charge the real tokens it used. Retries on temporary
    // gateway failures happen inside runBilledChat and are never charged.
    //
    // ── FIX: letter sometimes cut off mid-sentence ────────────────────────
    // A user reported a delivered letter that just stopped mid-word, no
    // period, nothing after — e.g. "...through their transactions by"
    // and nothing more. That is finish_reason:'length': the model hit the
    // 900-token cap before it finished, and this code only ever read
    // `text`, never `finishReason` (which runBilledChat/callAI already
    // compute and return — see the extract-file.js/extract-text.js
    // truncation fix this same pattern came from), so a genuinely
    // incomplete letter was silently delivered as if it were done.
    // Fixed two ways: (1) raised the cap so a normal 3-paragraph letter
    // has real headroom instead of running right up against it, and
    // (2) if it still gets cut off, ask the model to continue from
    // exactly where it stopped (up to 2 extra rounds) instead of handing
    // the user a truncated letter either way.
    const messages = [
      { role: 'system', content: 'You are a seasoned, empathetic ghostwriter who writes short, genuine, human-sounding job application letters. You follow the formatting rules you are given exactly and reply with the letter only — no preface, no commentary, no markdown.' },
      { role: 'user',   content: prompt }
    ];

    let result = await runBilledChat({
      userId, sessionToken,
      feature: 'LETTER_GENERATION',
      preAuth: { db, user },
      messages,
      maxTokens: 1400,
      temperature: 1.1
    });

    let fullText = result.text;
    let totalTokensUsed = result.tokensUsed;
    let tokenBalance = result.tokenBalance;

    const MAX_CONTINUATIONS = 2;
    for (let round = 0; round < MAX_CONTINUATIONS && result.finishReason === 'length'; round++) {
      console.log(`Letter generation truncated (finish_reason:length), requesting continuation ${round + 1}/${MAX_CONTINUATIONS} for ${userId}`);
      messages.push({ role: 'assistant', content: result.text });
      messages.push({ role: 'user', content: 'Your reply was cut off before the letter was finished. Continue writing EXACTLY where you left off — do not repeat anything already written, do not restart or re-greet, just pick up mid-sentence/mid-word if needed and finish the letter per the original instructions.' });

      result = await runBilledChat({
        userId, sessionToken,
        feature: 'LETTER_GENERATION',
        preAuth: { db, user },
        messages,
        maxTokens: 1400,
        temperature: 1.1
      });
      fullText += result.text;
      totalTokensUsed += result.tokensUsed;
      tokenBalance = result.tokenBalance;
    }

    let letterText = fullText.replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
    if (!letterText) throw new AIError(500, 'We are unable to generate your letter right now. Please try again in a moment.');

    // The model sometimes puts a blank line between the company name and
    // the "Subject: ..." line (as intended, so the subject reads as its
    // own block under the header) and sometimes doesn't, inconsistently
    // across generations. Rather than leave that to chance, normalize it
    // here: always exactly one blank line directly above the Subject line.
    letterText = letterText.replace(/\n+(?=Subject:)/, '\n\n');

    console.log(`Letter generated for ${userId}: ${totalTokensUsed} CT charged`);
    return { statusCode: 200, body: JSON.stringify({ letterText, tokensUsed: totalTokensUsed, tokenBalance }) };

  } catch (error) {
    if (error instanceof AIError) return errorResponse(error);
    console.error('Letter generation error:', error);
    // Never forward raw provider errors to the browser — they are technical
    // and can leak details. The real error is logged above for debugging.
    let errorMessage = 'We are unable to generate your letter right now. ';
    if (error.name === 'AbortError' || (error.message && /timeout|timed out/i.test(error.message))) {
      errorMessage += 'The request took too long. Please try again.';
    } else {
      errorMessage += 'Please try again in a moment.';
    }
    return { statusCode: 500, body: JSON.stringify({ error: errorMessage }) };
  }
};