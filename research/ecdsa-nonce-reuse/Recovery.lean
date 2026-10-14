import Mathlib

/- Algebraic recovery over a field. For ECDSA the intended field is ZMod n,
   with prime subgroup order n. This theorem does not model EC points,
   hash functions, signature parsing, randomness, or executable code. -/
theorem nonce_reuse_recovery {F : Type*} [Field F]
    (s1 s2 k z1 z2 r d : F)
    (h1 : s1 * k = z1 + r * d)
    (h2 : s2 * k = z2 + r * d)
    (hr : r ≠ 0) (hs : s1 - s2 ≠ 0) :
    k = (z1 - z2) / (s1 - s2) ∧
    d = (s1 * ((z1 - z2) / (s1 - s2)) - z1) / r := by
  have hk : k = (z1 - z2) / (s1 - s2) := by
    apply (eq_div_iff hs).2
    linear_combination h1 - h2
  have hd : d = (s1 * k - z1) / r := by
    apply (eq_div_iff hr).2
    linear_combination -h1
  constructor
  · exact hk
  · rw [← hk]
    exact hd

#print axioms nonce_reuse_recovery
