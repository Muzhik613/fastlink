// true only in the secure build (scripts/build-secure.sh rewrites this line). The normal
// extension never locks; the secure build accepts sealed calls only (src/secure/lock.js).
export const SECURE_BUILD = false;
