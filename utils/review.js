// When to ask "How is Tabazing working for you?". Pure functions: no storage, no network.
// Everything is counted on this device only and the rules are the same for everyone: every
// answer still offers the store review (nobody is filtered by how they feel), nothing is offered in return.
import { REVIEW } from './constants.js';

export const emptyReview = (now = Date.now()) => ({ since: now, opens: 0, soft: 0, lastSoft: 0, asks: 0, lastAsk: 0, done: false, day: '' });

// The local calendar day, as 'YYYY-M-D'.
export const dayOf = (now = Date.now()) => { const date = new Date(now); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; };

// -> 'ask' (the two-step dialog) or null. `firstToday`: this is the first open of the day, when
// people are usually in a hurry, so it never asks then.
export function reviewPrompt(review, now = Date.now(), { firstToday = false } = {}) {
  if (!review || review.done || firstToday) return null;
  if (review.asks >= REVIEW.ASK_MAX || review.opens < REVIEW.ASK_AFTER_OPENS || now - review.since < REVIEW.ASK_AFTER_MILLISECONDS) return null;
  return now - review.lastAsk >= REVIEW.ASK_GAP_MILLISECONDS ? 'ask' : null;
}
