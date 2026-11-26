/**
 * Domain model for the league structure Drawbridge renders.
 *
 * This package deliberately imports nothing from outside itself: the modules
 * below are pure and dependency free. It describes a Citadel league
 * snapshot structurally and derives the league structure (divisions, entries,
 * captains, byes) from it with pure functions, so any transport layer can
 * feed it without dragging dependencies along. On top of that structure the
 * plan builder turns a snapshot into the deterministic, hash bound list of
 * writes a tournament needs.
 */

export {
  ACCESS_LEVELS,
  type AccessLevel,
  type AccessOverwrite,
  type AccessPlan,
  type AccessPlanInput,
  type AccessPurpose,
  accessSetFor,
  CATEGORY_ACCESS,
  type ChannelKind,
  levelAtLeast,
  MATCH_ACCESS,
  planAccess,
  type StaffRole,
  TEAM_ACCESS,
  type TeamRole,
} from './access.js';
export { type CanonicalValue, canonicalJson } from './canonical.js';
export {
  type CapacityCategory,
  type CapacityHeadroomFlag,
  type CapacityPlan,
  type CapacityRefusal,
  type CapacityRequest,
  type CapacityScope,
  type CapacitySplit,
  type CapacitySplitPart,
  type CapacityStatus,
  type CapacityUsage,
  flagCapacityHeadroom,
  MAX_CATEGORIES,
  MAX_CHANNELS,
  MAX_CHANNELS_PER_CATEGORY,
  MAX_ROLES,
  planCapacity,
} from './capacity.js';
export * from './league.js';
export * from './naming.js';
export {
  buildTournamentPlan,
  type CaptainAssignment,
  type CaptainReport,
  type CaptainStatus,
  type CreateCategoryStep,
  type CreateChannelStep,
  type CreateRoleStep,
  type InsertDbRowStep,
  type PlanCell,
  type PlanColumn,
  type PlanCounts,
  type PlanDivision,
  type PlanEntry,
  type PlanLiteral,
  type PlanReference,
  type PlanStep,
  type PlanStepKind,
  type PlanWarning,
  type PlanWarningCode,
  type SetOverwritesStep,
  type TournamentPlan,
  type TournamentPlanOptions,
  type WelcomeMessageStep,
} from './plan.js';
export { sha256Hex } from './sha256.js';
