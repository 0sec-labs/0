/-
Reviewed educational model, not a TLS implementation or a new vulnerability.
Tickets are natural-number identifiers. Consumption is atomic and sequential;
caches never expire or reset. Authentication and application retries are omitted.
-/
import Std

namespace ZeroReplay

def consume (seen : List Nat) (ticket : Nat) : Bool × List Nat :=
  if ticket ∈ seen then (false, seen) else (true, ticket :: seen)

structure Cluster where
  left : List Nat
  right : List Nat

def empty : Cluster := ⟨[], []⟩

def localConsume (cluster : Cluster) (rightNode : Bool) (ticket : Nat) : Bool × Cluster :=
  if rightNode then
    let result := consume cluster.right ticket
    (result.1, { cluster with right := result.2 })
  else
    let result := consume cluster.left ticket
    (result.1, { cluster with left := result.2 })

-- One ticket is accepted by both nodes when their caches are independent.
theorem independent_caches_accept_replay :
    (localConsume empty false 7).1 = true ∧
    (localConsume (localConsume empty false 7).2 true 7).1 = true := by
  decide

-- The same node rejects the immediate replay, despite the cluster-wide failure.
theorem same_node_rejects_replay :
    (localConsume (localConsume empty false 7).2 false 7).1 = false := by
  decide

theorem consume_records_ticket (seen : List Nat) (ticket : Nat) :
    ticket ∈ (consume seen ticket).2 := by
  by_cases h : ticket ∈ seen <;> simp [consume, h]

theorem remembered_ticket_rejected (seen : List Nat) (ticket : Nat)
    (h : ticket ∈ seen) : (consume seen ticket).1 = false := by
  simp [consume, h]

-- A single shared atomic cache rejects the second consumption for ALL tickets
-- and initial cache states, not merely the example ticket 7.
theorem shared_cache_rejects_replay (seen : List Nat) (ticket : Nat) :
    (consume (consume seen ticket).2 ticket).1 = false := by
  exact remembered_ticket_rejected _ ticket (consume_records_ticket seen ticket)

#print axioms independent_caches_accept_replay
#print axioms same_node_rejects_replay
#print axioms consume_records_ticket
#print axioms remembered_ticket_rejected
#print axioms shared_cache_rejects_replay

end ZeroReplay
