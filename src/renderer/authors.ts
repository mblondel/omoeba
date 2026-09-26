/**
 * Matching author names written in different ways ("Yann LeCun", "Y. LeCun", "LeCun, Yann"),
 * and institution names (ignoring case, accents and punctuation).
 */

function parts(name: string): { first: string; last: string } {
  let n = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.’']/g, ' ')
    .trim();
  // "Last, First" -> "First Last"
  const comma = n.split(/\s*,\s*/);
  if (comma.length === 2 && comma[1]) n = `${comma[1]} ${comma[0]}`;
  const words = n.split(/[\s-]+/).filter(Boolean);
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] ?? '' };
}

/** Same person: same last name, and first names equal or compatible initials. */
export function sameAuthor(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (!x.last || x.last !== y.last) return false;
  if (!x.first || !y.first || x.first === y.first) return true;
  const fx = x.first.split(' ');
  const fy = y.first.split(' ');
  // One of them only has an initial: compare initials.
  if (fx[0].length === 1 || fy[0].length === 1) return fx[0][0] === fy[0][0];
  return fx[0] === fy[0];
}

/** Library search query selecting the papers of an author. */
export function authorQuery(name: string): string {
  return `author:"${name.replace(/"/g, '')}"`;
}

function normInstitution(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

export function sameInstitution(a: string, b: string): boolean {
  const x = normInstitution(a);
  return !!x && x === normInstitution(b);
}

/** Library search query selecting the papers of an institution. */
export function institutionQuery(name: string): string {
  return `inst:"${name.replace(/"/g, '')}"`;
}

/** Library search query selecting the papers with a tag (exact match, ignoring case). */
export function tagQuery(tag: string): string {
  return `tag:"${tag.replace(/"/g, '')}"`;
}
