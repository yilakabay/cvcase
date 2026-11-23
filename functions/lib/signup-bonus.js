// functions/lib/signup-bonus.js
//
// The one-time 100,000 CT welcome gift every brand-new CVcase account
// receives on signup (Telegram Mini App onboarding via telegram-auth.js, or
// web OTP signup via verify-otp.js) — plus the anti-abuse gate that stops
// someone from deleting their account and registering again to collect it
// a second time.
//
// Why a separate `bonus_claims` collection instead of just checking
// `users` for a previous account: delete-account.js permanently removes
// the `users` document (and even the `telegram_chats` link, by design —
// see that file's header comment) so a deleted account leaves NOTHING
// behind in `users` to check against. `bonus_claims` is never touched by
// delete-account.js — it's the one record that's meant to survive a
// deletion, exactly so the bonus can't be farmed by delete+re-register.
//
// Gated on TWO identities, either one alone blocking a re-grant:
//   - tgUserId    — the Telegram user ID (stable even if they later share a
//                   different phone number, or share none at all)
//   - phoneNumber — but ONLY a real one ever shared with the bot/OTP flow,
//                   never the synthetic "tg_<id>" placeholder telegram-auth.js
//                   gives phoneless Telegram users (that placeholder is
//                   derived from tgUserId anyway, so recording it would be
//                   redundant, and it would wrongly collide across different
//                   Telegram users if it weren't tgUserId-derived).
// This also blocks the "new Telegram account, same real phone number"
// route: if that phone already claimed the bonus under a different
// tgUserId, it can't claim it again under this one either.

const crypto = require('crypto');

const SIGNUP_BONUS_CT = 100000;

let indexesEnsured = false;
async function ensureBonusClaimIndexes(db) {
  if (indexesEnsured) return;
  const col = db.collection('bonus_claims');
  try {
    await Promise.all([
      col.createIndex({ tgUserId: 1 },    { unique: true, partialFilterExpression: { tgUserId:    { $type: 'string' } } }),
      col.createIndex({ phoneNumber: 1 }, { unique: true, partialFilterExpression: { phoneNumber: { $type: 'string' } } })
    ]);
  } catch (err) {
    console.error('signup-bonus: ensureBonusClaimIndexes failed', err);
  }
  indexesEnsured = true;
}

// Returns the CT amount actually granted (SIGNUP_BONUS_CT or 0 if this
// identity already claimed it before, or there's no identity to key a claim
// on at all). Never throws for the "already claimed" case — only for a
// genuine DB error.
async function claimSignupBonus(db, { tgUserId, realPhoneNumber }) {
  await ensureBonusClaimIndexes(db);
  const bonusCol = db.collection('bonus_claims');

  const orClauses = [];
  if (tgUserId)        orClauses.push({ tgUserId });
  if (realPhoneNumber) orClauses.push({ phoneNumber: realPhoneNumber });
  if (orClauses.length === 0) return 0;

  const already = await bonusCol.findOne({ $or: orClauses });
  if (already) return 0;

  try {
    await bonusCol.insertOne({
      tgUserId:    tgUserId || null,
      phoneNumber: realPhoneNumber || null,
      amount:      SIGNUP_BONUS_CT,
      createdAt:   new Date()
    });
  } catch (err) {
    // Duplicate key = a concurrent request for the same identity already
    // claimed it a moment ago — treat exactly like "already claimed", not
    // an error.
    if (err && err.code === 11000) return 0;
    throw err;
  }
  return SIGNUP_BONUS_CT;
}

// The in-app notification explaining what CT is and why this account has
// some, shown the first time a brand-new user opens their notifications.
function signupBonusNotification(amount) {
  return {
    id:        crypto.randomUUID(),
    read:      false,
    type:      'signup_bonus',
    tokens:    amount,
    amount:    null,
    createdAt: new Date()
  };
}

module.exports = { SIGNUP_BONUS_CT, claimSignupBonus, signupBonusNotification };
