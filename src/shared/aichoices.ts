/**
 * The AIs offered in Omoeba's menus: each authorized AI command-line tool once per model listed
 * for it in the settings, e.g. "Claude Code · Sonnet": the same command with `--model sonnet`
 * (so that the menus say which model answers). An AI with no models listed is offered as it is
 * (its own default model). A choice's id is the AI's id, or "id:model"; summaries
 * are kept under it (so that a summary says which model wrote it).
 */
import type { AIProvider } from './types';

/** "sonnet" → "Sonnet" (a model's name in the menus); names such as "gpt-5" are kept as they are. */
export const modelLabel = (model: string) => (/^[a-z]+$/.test(model) ? model[0].toUpperCase() + model.slice(1) : model);

/** The AI with this model: its arguments with the model option (after a subcommand such as "exec"). */
export function withModel(ai: AIProvider, model: string): AIProvider {
  const args = [...ai.args];
  const at = args.length && !args[0].startsWith('-') && !args[0].includes('{') ? 1 : 0;
  args.splice(at, 0, ai.modelFlag || '--model', model);
  return { ...ai, id: `${ai.id}:${model}`, name: `${ai.name} · ${modelLabel(model)}`, args, models: [] };
}

/** The choices: of the authorized AIs (or of all, `all`), each with its models (or as it is, without). */
export function aiChoices(ais: AIProvider[], all = false): AIProvider[] {
  const out: AIProvider[] = [];
  for (const ai of ais) {
    if (!all && !ai.enabled) continue;
    const models = (ai.models ?? []).map((m) => m.trim()).filter(Boolean);
    if (!models.length) out.push(ai);
    for (const m of models) out.push(withModel(ai, m));
  }
  return out;
}

/**
 * The AI for this id (authorized or not): a choice, or an AI as it is (its own default model:
 * e.g. "claude" for summaries written before models were offered).
 */
export function findAIChoice(ais: AIProvider[], id: string | null | undefined): AIProvider | undefined {
  if (!id) return undefined;
  const found = aiChoices(ais, true).find((a) => a.id === id) ?? ais.find((a) => a.id === id);
  if (found) return found;
  // (A model no longer listed in the settings: still that AI with that model.)
  const i = id.indexOf(':');
  const base = i > 0 ? ais.find((a) => a.id === id.slice(0, i)) : undefined;
  return base ? withModel(base, id.slice(i + 1)) : undefined;
}

/** The name shown for a choice ("Claude Code · Sonnet"), or its id if unknown. */
export const aiChoiceName = (ais: AIProvider[], id: string) => findAIChoice(ais, id)?.name ?? id;

/** The id of a choice for this id: an AI that now has models listed → its first model. */
export function asAIChoice(ais: AIProvider[], id: string | null | undefined): string | null {
  if (!id) return null;
  const choices = aiChoices(ais);
  if (choices.some((a) => a.id === id)) return id;
  const ai = ais.find((a) => a.id === id && a.enabled);
  const first = ai && choices.find((c) => c.id.startsWith(`${ai.id}:`));
  return first?.id ?? null;
}

/**
 * Where a choice's conversations were kept before models were offered: "claude" for the AI's
 * first model ("claude:opus"); else null. (They are shown with that model, and moved on its next answer.)
 */
export function formerChatKey(ais: AIProvider[], id: string): string | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  const ai = ais.find((a) => a.id === id.slice(0, i));
  return ai && (ai.models ?? [])[0] === id.slice(i + 1) ? ai.id : null;
}
