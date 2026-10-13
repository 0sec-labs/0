/- Educational application-security models. These proofs concern the definitions
below, not Node.js execution, production systems, TLS, or cryptographic security.
Sequential atomic transitions, stable tenant ownership, natural-number balances,
and a persistent monotonic nonce counter are assumptions. -/
import Std

namespace ZeroSecurityDemos

def authorized (actorTenant resourceTenant : Nat) : Bool :=
  decide (actorTenant = resourceTenant)

-- Bug: a successful login is treated as authorization for every tenant.
def loginOnlyAccess (_actorTenant _resourceTenant : Nat) : Bool := true

theorem cross_tenant_counterexample :
    loginOnlyAccess 1 2 = true ∧ authorized 1 2 = false := by decide

theorem tenant_isolation (actorTenant resourceTenant : Nat)
    (accepted : authorized actorTenant resourceTenant = true) :
    actorTenant = resourceTenant := by
  simpa [authorized] using accepted

structure Account where
  balance : Nat
  paid : Nat
  deriving DecidableEq

-- Each request uses the same stale snapshot to choose its next balance.
def staleCommit (snapshot : Nat) (current : Account) (amount : Nat) : Account :=
  ⟨snapshot - amount, current.paid + amount⟩

def atomicPay (current : Account) (amount : Nat) : Account :=
  if amount ≤ current.balance then
    ⟨current.balance - amount, current.paid + amount⟩
  else current

theorem stale_authorization_counterexample :
    let initial : Account := ⟨10, 0⟩
    let first := staleCommit initial.balance initial 7
    let second := staleCommit initial.balance first 7
    second.balance + second.paid = 17 := by decide

theorem atomic_payment_conserves (current : Account) (amount : Nat) :
    (atomicPay current amount).balance + (atomicPay current amount).paid =
    current.balance + current.paid := by
  by_cases h : amount ≤ current.balance
  · simp [atomicPay, h]
    omega
  · simp [atomicPay, h]

theorem atomic_payment_cannot_overspend (current : Account) (amount : Nat) :
    (atomicPay current amount).balance ≤ current.balance := by
  by_cases h : amount ≤ current.balance
  · simp [atomicPay, h]
  · simp [atomicPay, h]

-- Tiny finite counter illustrates wrapping; it is not an encryption scheme.
def wrappingNonce (counter : Nat) : Nat := counter % 4
def freshNonce (limit counter : Nat) : Option Nat :=
  if counter < limit then some counter else none

theorem rollover_counterexample : wrappingNonce 0 = wrappingNonce 4 := by decide

theorem fresh_nonce_is_bounded (limit counter nonce : Nat)
    (accepted : freshNonce limit counter = some nonce) : nonce < limit := by
  by_cases h : counter < limit
  · simp [freshNonce, h] at accepted
    omega
  · simp [freshNonce, h] at accepted

theorem distinct_counters_have_distinct_nonces (limit first second a b : Nat)
    (firstAccepted : freshNonce limit first = some a)
    (secondAccepted : freshNonce limit second = some b)
    (different : first ≠ second) : a ≠ b := by
  by_cases h₁ : first < limit
  · by_cases h₂ : second < limit
    · simp [freshNonce, h₁] at firstAccepted
      simp [freshNonce, h₂] at secondAccepted
      omega
    · simp [freshNonce, h₂] at secondAccepted
  · simp [freshNonce, h₁] at firstAccepted

#print axioms cross_tenant_counterexample
#print axioms tenant_isolation
#print axioms stale_authorization_counterexample
#print axioms atomic_payment_conserves
#print axioms atomic_payment_cannot_overspend
#print axioms rollover_counterexample
#print axioms fresh_nonce_is_bounded
#print axioms distinct_counters_have_distinct_nonces

end ZeroSecurityDemos
