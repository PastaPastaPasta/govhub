import { base58, base64, idToBytes, isIdentifier, type DocumentOp, type DocData } from '@govhub/forum';

export const POLL_CONTRACT = 'GBCR8JqtXNMZa4B16ZAYm3RkNHrPcU3D36jcAoYWvr8E';
export const ARCHIVE_CONTRACT = '7Xye3k1MuVYTpLuTnein5GLwR1NUjmt5gtLLp4pGhhRf';
export interface Poll {
  id: string;
  owner: string;
  createdAt: number;
  question: string;
  options: string[];
  multiChoice: boolean;
  endsAt?: number;
}
export interface Draft { question: string; options: string[]; multiChoice: boolean; close: string }
export const emptyDraft = (): Draft => ({ question: '', options: ['', ''], multiChoice: false, close: '' });
export const DRAFT_KEY = 'gov-poll-draft-v1';
export const closed = (p: Poll, now = Date.now()): boolean => p.endsAt !== undefined && p.endsAt <= now;
export const voteType = (p: Poll): string => p.multiChoice ? 'multiVote' : 'vote';

export function readDraft(storage: Pick<Storage, 'getItem'>): Draft {
  try {
    const d = JSON.parse(storage.getItem(DRAFT_KEY) ?? 'null');
    if (d && typeof d.question === 'string' && d.question.length <= 512 && Array.isArray(d.options) && d.options.length >= 2 && d.options.length <= 10 && d.options.every((o: unknown) => typeof o === 'string' && o.length <= 100) && typeof d.multiChoice === 'boolean' && typeof d.close === 'string') return d;
  } catch { /* Unavailable storage or an invalid saved draft starts empty. */ }
  return emptyDraft();
}

export function pollOperation(d: Draft, now = Date.now()): DocumentOp {
  const question = d.question.trim(), options = d.options.map(o => o.trim());
  if (!question || question.length > 512) throw Error('Write a question of 1–512 characters.');
  if (options.length < 2 || options.length > 10 || options.some(o => !o || o.length > 100)) throw Error('Add 2–10 options, each with 1–100 characters.');
  if (new Set(options.map(o => o.toLowerCase())).size !== options.length) throw Error('Give each option different wording.');
  const endsAt = d.close ? new Date(d.close).getTime() : undefined;
  if (endsAt !== undefined && (!Number.isSafeInteger(endsAt) || endsAt <= now)) throw Error('Choose a close date in the future, or leave it blank.');
  const data: DocData = { question, $createdAt: now };
  options.forEach((o, i) => { data[`option${i}`] = o; });
  if (d.multiChoice) data.multiChoice = true;
  if (endsAt !== undefined) data.endsAt = endsAt;
  return { action: 'create', contractId: POLL_CONTRACT, type: 'poll', data };
}

export function answerOperations(p: Poll, choices: number[], now = Date.now()): DocumentOp[] {
  const selected = [...new Set(choices)];
  if (closed(p, now)) throw Error('This poll has closed.');
  if (!selected.length || (!p.multiChoice && selected.length !== 1) || selected.some(c => !Number.isInteger(c) || c < 0 || c >= p.options.length)) throw Error('Choose a valid answer.');
  return selected.map(choice => ({ action: 'create', contractId: POLL_CONTRACT, type: voteType(p), data: { pollId: idToBytes(p.id), pollOwnerId: idToBytes(p.owner), choice, $createdAt: now } }));
}

export function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v);
  if (typeof v === 'string') return base64.decode(v);
  throw Error('Malformed record bytes.');
}
export function identifier(v: unknown): string {
  const id = typeof v === 'string' && isIdentifier(v) ? v : base58.encode(bytes(v));
  if (!isIdentifier(id)) throw Error('Malformed record identifier.');
  return id;
}
export function decodePoll(d: Record<string, unknown>, archive = false): Poll {
  const options: string[] = [];
  let question: unknown = d.question;
  if (archive) {
    question = new TextDecoder('utf-8', { fatal: true }).decode(bytes(d.question));
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(d.options)));
    if (!Array.isArray(raw) || raw.some(o => typeof o !== 'string')) throw Error('Malformed archived options.');
    options.push(...raw);
  } else {
    for (let i = 0; i < 10; i++) {
      if (typeof d[`option${i}`] === 'string') options.push(d[`option${i}`] as string);
      else if (Object.keys(d).some(k => /^option\d$/.test(k) && Number(k.slice(6)) > i)) throw Error('Poll has a missing option.');
      else break;
    }
  }
  const createdAt = Number(d.$createdAt), endsAt = d.endsAt == null ? undefined : Number(d.endsAt);
  if (typeof question !== 'string' || !question.trim() || options.length < 2 || options.length > 10 || !Number.isSafeInteger(createdAt) || (endsAt !== undefined && !Number.isSafeInteger(endsAt))) throw Error('Malformed poll record.');
  return { id: identifier(d.$id), owner: identifier(d.$ownerId), createdAt, question, options, multiChoice: archive ? d.pollType === 1 : d.multiChoice === true, endsAt };
}

export interface Tally { counts: number[]; late: number[]; identities: number; selections: number; userChoices: number[] }
export function tally(p: Poll, docs: Record<string, unknown>[], viewer?: string, archive = false): Tally {
  const counts = p.options.map(() => 0), late = p.options.map(() => 0), seen = new Set<string>(), voters = new Set<string>(), userChoices: number[] = [];
  for (const d of docs) {
    if (identifier(d.pollId) !== p.id) continue;
    const owner = identifier(d.$ownerId);
    const choices = archive ? [...new Set([...bytes(d.selectedOptions)].filter(c => c !== 255))] : [Number(d.choice)];
    if ((!p.multiChoice && choices.length !== 1) || choices.some(c => !Number.isInteger(c) || c < 0 || c >= counts.length)) throw Error('Malformed answer record.');
    const time = Number(d.$createdAt);
    if (!Number.isSafeInteger(time)) throw Error('Answer time unavailable.');
    const after = p.endsAt !== undefined && time > p.endsAt;
    for (const choice of choices) {
      const unique = `${owner}:${p.multiChoice ? choice : 'ballot'}`;
      if (seen.has(unique)) continue;
      seen.add(unique);
      if (after) late[choice]!++;
      else { counts[choice]!++; voters.add(owner); }
      if (owner === viewer) userChoices.push(choice);
    }
  }
  return { counts, late, identities: voters.size, selections: counts.reduce((a, b) => a + b, 0), userChoices };
}
