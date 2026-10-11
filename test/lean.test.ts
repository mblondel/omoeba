/** Lean in Markdown code blocks: syntax highlighting in the preview. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAN_ABBREVIATIONS, highlightLean, leanConvertsBefore } from '../src/renderer/lean';

const textOf = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const SAMPLE = `import Mathlib
/-- The sum of two even numbers is even. -/
@[simp] theorem even_add {m n : ℕ} (hm : Even m) (hn : Even n) : Even (m + n) := by
  obtain ⟨a, rfl⟩ := hm  -- m = a + a
  rcases hn with ⟨b, rfl⟩
  exact ⟨a + b, by ring⟩

/- nested /- comment -/ still a comment -/
def f (x : Nat) : Type := sorry
example : "a \\"string\\"" = 'c'.toString ∧ h' = 0x1F := by simp
`;

test('lean: the text is never changed; syntax is marked', () => {
  const html = highlightLean(SAMPLE);
  assert.equal(textOf(html), SAMPLE);
  for (const s of ['let x := 1', '/- unclosed', '"unclosed', "h' := h''", '@[simp', '-- only', '', '∀∃λ→', '<&>']) assert.equal(textOf(highlightLean(s)), s, s);
  const has = (cls: string, text: string) => assert.ok(html.includes(`<span class="${cls}">${text}</span>`), `${cls}: ${text}`);
  has('lean-keyword', 'import');
  has('lean-keyword', 'theorem');
  has('lean-keyword', 'by');
  has('lean-keyword', 'obtain');
  has('lean-tactic', 'rcases');
  has('lean-tactic', 'exact');
  has('lean-tactic', 'ring');
  has('lean-tactic', 'rfl');
  has('lean-comment', '/-- The sum of two even numbers is even. -/');
  has('lean-comment', '-- m = a + a');
  has('lean-comment', '/- nested /- comment -/ still a comment -/');
  has('lean-attr', '@[simp]');
  has('lean-const', 'Even');
  has('lean-const', 'Nat');
  has('lean-type', 'Type');
  has('lean-sorry', 'sorry');
  has('lean-string', '"a \\"string\\""');
  has('lean-string', "'c'");
  has('lean-num', '0x1F');
  has('lean-sym', '⟨');
  has('lean-sym', ':=');
  assert.ok(html.includes("h'"), 'primes in names are not characters');
});

test('lean: abbreviations converted on a space or punctuation, as in Lean', () => {
  assert.equal(LEAN_ABBREVIATIONS.alpha, 'α');
  assert.equal(LEAN_ABBREVIATIONS.Gamma, 'Γ');
  assert.equal(LEAN_ABBREVIATIONS.upsilon, 'υ');
  assert.ok(leanConvertsBefore('alpha', ' '));
  assert.ok(leanConvertsBefore('alpha', ')'), '(x : \\alpha)');
  assert.ok(leanConvertsBefore('beta', ','));
  assert.ok(!leanConvertsBefore('al', 'p'), 'letters go on with the abbreviation');
  assert.ok(!leanConvertsBefore('R', 'i'), 'nor cut a longer name short');
  assert.ok(!leanConvertsBefore('<', '='), '\\<= is still being typed');
  assert.ok(!leanConvertsBefore('-', '>'));
  assert.ok(leanConvertsBefore('->', ')'));
});
