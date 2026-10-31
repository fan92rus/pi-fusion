/**
 * TypeBox schema of the `fusion_delegate` tool arguments — the
 * FusionContract form (design §4: "форма без логики", FR-001/FR-002).
 *
 * Validation here is shape only; semantics stay in contract/validate.ts
 * (owner/provide/require references, dup ids, title defaults, the
 * rendered-contract ceiling). The form itself is strict: unknown
 * top-level fields are rejected.
 */
import { Type } from "@sinclair/typebox";
import { DelegateContractSchema, FusionTaskSchema, MAX_DELEGATE_TASKS } from "../types.ts";

export const FusionContractSchema = Type.Object(
  {
    /** 1..16 independent tasks (cap D-005). */
    tasks: Type.Array(FusionTaskSchema, { minItems: 1, maxItems: MAX_DELEGATE_TASKS }),
    /** Requested fan-out width; ≥1, no upper bound — clamped downstream. */
    maxWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Cross-task contract; an object, validated by DelegateContractSchema. */
    contract: Type.Optional(DelegateContractSchema),
  },
  { additionalProperties: false },
);
