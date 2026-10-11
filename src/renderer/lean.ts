/**
 * Lean 4 in Markdown code blocks (```lean): Lean's \abbreviations (typed in the editor: \forall
 * then a space gives ∀, as in Lean's editors), and syntax highlighting for the preview (the text
 * only wrapped in spans and escaped).
 */

/** Lean's input abbreviations (the most used ones). */
export const LEAN_ABBREVIATIONS: Record<string, string> = {
  // Logic
  forall: '∀', all: '∀', exists: '∃', ex: '∃', nexists: '∄', and: '∧', or: '∨', not: '¬', neg: '¬',
  to: '→', r: '→', '->': '→', l: '←', '<-': '←', iff: '↔', lr: '↔', '<->': '↔', '=>': '⇒', 'r=': '⇒',
  top: '⊤', bot: '⊥', '|-': '⊢', vdash: '⊢', mapsto: '↦', '|->': '↦',
  // Relations
  ne: '≠', neq: '≠', '=n': '≠', le: '≤', '<=': '≤', ge: '≥', '>=': '≥', lt: '<', gt: '>',
  approx: '≈', equiv: '≡', '==': '≡', cong: '≅', '~': '∼', sim: '∼', simeq: '≃', '~-': '≃', dvd: '∣', '|': '∣',
  // Sets
  in: '∈', mem: '∈', notin: '∉', nin: '∉', sub: '⊂', subset: '⊂', ss: '⊆', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', un: '∪', cap: '∩', inter: '∩', empty: '∅', emptyset: '∅', compl: 'ᶜ', '\\': '\\',
  // Lattices, algebra
  inf: '⊓', sqcap: '⊓', sup: '⊔', sqcup: '⊔', bigcup: '⋃', Union: '⋃', bigcap: '⋂', Inter: '⋂',
  times: '×', x: '×', prod: '∏', sum: '∑', circ: '∘', comp: '∘', o: '∘', cdot: '·', '.': '·', bullet: '•',
  pm: '±', sqrt: '√', infty: '∞', inv: '⁻¹', '-1': '⁻¹', '^-1': '⁻¹', nabla: '∇', partial: '∂', int: '∫', oplus: '⊕', otimes: '⊗',
  norm: '‖', '||': '‖', langle: '⟨', rangle: '⟩', '<': '⟨', '>': '⟩', f: '↑', u: '↑', uparrow: '↑', d: '↓', downarrow: '↓',
  // Number systems
  N: 'ℕ', nat: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ',
  // Greek
  a: 'α', alpha: 'α', b: 'β', beta: 'β', g: 'γ', gamma: 'γ', delta: 'δ', e: 'ε', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', th: 'θ', theta: 'θ', iota: 'ι', k: 'κ', kappa: 'κ', lam: 'λ', lambda: 'λ', fun: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', s: 'σ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', w: 'ω', omega: 'ω',
  G: 'Γ', Gamma: 'Γ', D: 'Δ', Delta: 'Δ', Theta: 'Θ', L: 'Λ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', S: 'Σ', Sigma: 'Σ',
  Phi: 'Φ', Psi: 'Ψ', W: 'Ω', Omega: 'Ω',
  // Subscripts
  _0: '₀', _1: '₁', _2: '₂', _3: '₃', _4: '₄', _5: '₅', _6: '₆', _7: '₇', _8: '₈', _9: '₉', _i: 'ᵢ', _j: 'ⱼ', _n: 'ₙ', _k: 'ₖ',
};

const KEYWORDS = new Set(
  (
    'theorem lemma def abbrev example instance structure class inductive coinductive where deriving extends namespace section end ' +
    'open export variable universe import noncomputable private protected partial unsafe mutual axiom opaque macro macro_rules syntax ' +
    'notation infix infixl infixr prefix postfix set_option attribute local scoped fun let have show from by at with match if then ' +
    'else do return for in unless mut calc suffices obtain using termination_by decreasing_by λ'
  ).split(' '),
);
const TACTICS = new Set(
  (
    'intro intros exact apply refine refine\' rw rewrite rwa simp simp_all simpa dsimp norm_num ring ring_nf linarith nlinarith ' +
    'omega decide rfl constructor cases rcases induction rintro use exists left right exfalso contradiction assumption trivial ' +
    'aesop positivity field_simp unfold change specialize gcongr ext funext congr subst split split_ifs by_contra by_cases push_neg ' +
    'tauto done first try repeat all_goals any_goals case next conv exact? apply? simp? norm_cast push_cast exact_mod_cast ' +
    'nth_rewrite nth_rw calc show_term clear revert generalize set refine_lift infer_instance'
  ).split(' '),
);
const TYPES = new Set(['Type', 'Prop', 'Sort']);

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const span = (cls: string, s: string) => `<span class="${cls}">${esc(s)}</span>`;

const TOKEN = new RegExp(
  [
    /(?<comment>--[^\n]*)/u.source,
    /(?<block>\/-)/u.source,
    /(?<string>"(?:\\.|[^"\\])*"?)/u.source,
    /(?<char>(?<![\p{L}\p{N}_'])'(?:\\.|[^'\\\n])')/u.source,
    /(?<attr>@\[[^\]\n]*\]?)/u.source,
    /(?<num>\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[0-9a-fA-F]+\b)/u.source,
    /(?<ident>[\p{L}_][\p{L}\p{N}_'!?₀-₉ᵢⱼₙₖ]*(?:\.[\p{L}_][\p{L}\p{N}_'!?₀-₉ᵢⱼₙₖ]*)*)/u.source,
    /(?<sym>:=|[∀∃∄λ→←↔⇒∧∨¬⊢↦≠≤≥≈≡≅∼≃∣∈∉⊂⊆⊃⊇∪∩∅⊓⊔⋃⋂×∏∑∘·•±√∞⁻¹∇∂∫⊕⊗‖⟨⟩↑↓⊤⊥|:])/u.source,
  ].join('|'),
  'gu',
);

/** Lean code as HTML (spans with lean-* classes). */
export function highlightLean(code: string): string {
  let out = '';
  let last = 0;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(code))) {
    const g = m.groups!;
    out += esc(code.slice(last, m.index));
    let text = m[0];
    if (g.block) {
      // A block comment /- … -/ (nested), or a doc comment /-- … -/.
      let depth = 0;
      let j = m.index;
      for (; j < code.length; j++) {
        if (code.startsWith('/-', j)) {
          depth++;
          j++;
        } else if (code.startsWith('-/', j)) {
          depth--;
          j++;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      text = code.slice(m.index, j);
      out += span('lean-comment', text);
      TOKEN.lastIndex = m.index + text.length;
    } else if (g.comment) out += span('lean-comment', text);
    else if (g.string || g.char) out += span('lean-string', text);
    else if (g.attr) out += span('lean-attr', text);
    else if (g.num) out += span('lean-num', text);
    else if (g.ident) {
      if (text === 'sorry' || text === 'admit') out += span('lean-sorry', text);
      else if (KEYWORDS.has(text)) out += span('lean-keyword', text);
      else if (TACTICS.has(text)) out += span('lean-tactic', text);
      else if (TYPES.has(text)) out += span('lean-type', text);
      else if (/^\p{Lu}/u.test(text.split('.').pop() ?? '')) out += span('lean-const', text);
      else out += esc(text);
    } else if (g.sym) out += span('lean-sym', text);
    else out += esc(text);
    last = m.index + text.length;
  }
  return out + esc(code.slice(last));
}
