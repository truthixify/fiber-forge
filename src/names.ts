/**
 * A pool of recognizable names — philosophers, mathematicians, scientists, and historical figures
 * — so networks are fun to explore. Nodes are named from here instead of `n1, n2, …`; you refer to
 * them by name in `fiber-forge pay <from> <to>`, channel ops, and the GUI.
 */

export const NAME_POOL = [
  // philosophers
  "plato",
  "aristotle",
  "socrates",
  "kant",
  "hume",
  "nietzsche",
  "descartes",
  "spinoza",
  "locke",
  "hegel",
  "confucius",
  "seneca",
  // mathematicians
  "euler",
  "gauss",
  "riemann",
  "euclid",
  "cantor",
  "turing",
  "godel",
  "noether",
  "ramanujan",
  "hilbert",
  "fermat",
  "leibniz",
  "lovelace",
  "hypatia",
  "pythagoras",
  // physicists & scientists
  "newton",
  "einstein",
  "bohr",
  "curie",
  "feynman",
  "dirac",
  "planck",
  "heisenberg",
  "maxwell",
  "tesla",
  "faraday",
  "hawking",
  "galileo",
  "fermi",
  "darwin",
  "mendel",
  "pasteur",
  "kepler",
  "hopper",
  "lorentz",
  // historical & political figures
  "lincoln",
  "gandhi",
  "mandela",
  "cleopatra",
  "caesar",
  "napoleon",
  "hammurabi",
  "ashoka",
  "pericles",
] as const;

/**
 * `count` distinct names from the pool, in random order — so every network gets a fresh, fun cast.
 * If the pool is exhausted (more nodes than names), remaining nodes fall back to `node<i>`.
 */
export function pickNames(count: number): string[] {
  const pool = [...NAME_POOL] as string[];
  const chosen: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (pool.length === 0) {
      chosen.push(`node${i + 1}`);
      continue;
    }
    const index = Math.floor(Math.random() * pool.length);
    chosen.push(pool.splice(index, 1)[0]);
  }
  return chosen;
}
