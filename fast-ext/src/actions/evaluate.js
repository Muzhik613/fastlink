// fast_evaluate is not part of this extension. Page JavaScript exists only in the secure
// build (one owner-controlled browser): scripts/build-secure.sh replaces this file with
// fast-ext/secure-only/evaluate.js and adds the userScripts permission.
export async function evaluate() {
  return { error: 'fast_evaluate is not available in this FastLink build.' };
}
