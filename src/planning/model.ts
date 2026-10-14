import { TASK_ID } from '../tasks/task.js';
import { arr, bool, int, obj, oneOf, opt, str, type Check } from './schema.js';

// ------------------------------------------------------------------- idea

export const PLATFORMS = ['website', 'saas', 'android', 'ios', 'desktop', 'api'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * What a person enters to start planning. Only the name and the idea are
 * required; the planner proposes defaults for everything else and labels them
 * as assumptions.
 */
export interface IdeaInput {
  name: string;
  idea: string;
  targetUsers: string;
  market: string;
  research: string;
  referenceUrls: string[];
  businessModel: string;
  platforms: Platform[];
  constraints: string;
  budget: string;
  preferredTech: string;
  /** Absolute path of an existing codebase to extend (must be under an allowed root). */
  existingCodebasePath: string;
  /** Answers to blocking questions the planner asked, in order. */
  clarifications: { question: string; answer: string }[];
}

const URL_PATTERN = /^https?:\/\/[^\s"'<>]{3,2000}$/i;
const optText = (max: number) => opt(str({ min: 0, max }), '');

export const ideaCheck: Check<IdeaInput> = obj({
  name: str({ min: 2, max: 80 }),
  idea: str({ min: 20, max: 10_000 }),
  targetUsers: optText(2000),
  market: optText(2000),
  research: optText(100_000),
  referenceUrls: opt(arr(str({ pattern: URL_PATTERN, label: 'must be an http(s) URL', max: 2000 }), { max: 50 }), []),
  businessModel: optText(2000),
  platforms: opt(arr(oneOf(PLATFORMS), { max: PLATFORMS.length }), []),
  constraints: optText(5000),
  budget: optText(1000),
  preferredTech: optText(2000),
  existingCodebasePath: optText(1000),
  clarifications: opt(arr(obj({ question: str({ max: 2000 }), answer: str({ max: 5000 }) }), { max: 10 }), []),
}) as Check<IdeaInput>;

// ------------------------------------------------------- shared elements

/**
 * How a statement is known. Only `verified` claims something was checked, and
 * it must cite a web or codebase source the planner actually had access to.
 */
export const BASES = ['user-provided', 'verified', 'assumption', 'recommendation'] as const;
export type Basis = (typeof BASES)[number];

export const SOURCE_KINDS = ['user-supplied', 'web', 'codebase'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceRef {
  id: string;
  title: string;
  kind: SourceKind;
  url: string;
  retrievedAt: string;
  notes: string;
}

export interface Statement {
  statement: string;
  basis: Basis;
  sourceIds: string[];
}

const SOURCE_ID = /^SRC-[0-9]{1,3}$/;
const sourceCheck: Check<SourceRef> = obj({
  id: str({ pattern: SOURCE_ID, label: 'must look like SRC-1' }),
  title: str({ max: 300 }),
  kind: oneOf(SOURCE_KINDS),
  url: optText(2000),
  retrievedAt: optText(40),
  notes: optText(2000),
}) as Check<SourceRef>;
const statementCheck: Check<Statement> = obj({
  statement: str({ max: 2000 }),
  basis: oneOf(BASES),
  sourceIds: opt(arr(str({ pattern: SOURCE_ID, label: 'must look like SRC-1' }), { max: 20 }), []),
}) as Check<Statement>;

const feasibilityCheck = obj({ feasible: bool(), issues: opt(arr(str({ max: 2000 }), { max: 20 }), []) });
const texts = (min = 0, max = 50, chars = 2000) => arr(str({ max: chars }), { min, max });

export const PROJECT_TYPES = ['web-app', 'saas', 'api', 'mobile', 'desktop', 'existing-codebase'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

// --------------------------------------------------------------- proposal

/** The concise product proposal a person approves or rejects. */
export interface Proposal {
  productName: string;
  summary: string;
  problem: string;
  targetUsers: string[];
  valueProposition: string;
  projectType: ProjectType;
  platforms: Platform[];
  mvpScope: string[];
  outOfScope: string[];
  effort: { estimatedTasks: number; complexity: 'small' | 'medium' | 'large'; notes: string };
  recurringCosts: { item: string; estimate: string; basis: Basis; notes: string }[];
  risks: { risk: string; severity: 'low' | 'medium' | 'high'; mitigation: string }[];
  statements: Statement[];
  sources: SourceRef[];
  openQuestions: string[];
  /** Set only when planning cannot reasonably continue without the person's answer. */
  blockingQuestion: string;
  feasibility: { feasible: boolean; issues: string[] };
}

export const proposalCheck: Check<Proposal> = obj({
  productName: str({ max: 80 }),
  summary: str({ max: 3000 }),
  problem: str({ max: 3000 }),
  targetUsers: texts(1, 20, 500),
  valueProposition: str({ max: 2000 }),
  projectType: oneOf(PROJECT_TYPES),
  platforms: arr(oneOf(PLATFORMS), { min: 1, max: PLATFORMS.length }),
  mvpScope: texts(1, 40),
  outOfScope: opt(texts(0, 40), []),
  effort: obj({ estimatedTasks: int(1, 500), complexity: oneOf(['small', 'medium', 'large'] as const), notes: optText(2000) }),
  recurringCosts: opt(arr(obj({ item: str({ max: 300 }), estimate: str({ max: 300 }), basis: oneOf(BASES), notes: optText(1000) }), { max: 30 }), []),
  risks: opt(arr(obj({ risk: str({ max: 1000 }), severity: oneOf(['low', 'medium', 'high'] as const), mitigation: str({ max: 1000 }) }), { max: 30 }), []),
  statements: opt(arr(statementCheck, { max: 80 }), []),
  sources: opt(arr(sourceCheck, { max: 60 }), []),
  openQuestions: opt(texts(0, 30), []),
  blockingQuestion: optText(1000),
  feasibility: feasibilityCheck,
}) as Check<Proposal>;

// ------------------------------------------------------------- full plan

export const RISK_FLAGS = [
  'authentication',
  'authorization',
  'payments',
  'personal-data',
  'secrets',
  'external-integration',
  'data-deletion',
  'migration',
  'deployment',
  'paid-resource',
  'legal',
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];
/** Flags that always need at least medium risk and are never auto-accepted. */
export const SENSITIVE_FLAGS: readonly RiskFlag[] = ['authentication', 'authorization', 'payments', 'secrets', 'data-deletion', 'migration', 'deployment', 'paid-resource', 'legal'];

export const TASK_CATEGORIES = ['foundation', 'feature', 'integration', 'testing', 'security', 'release'] as const;

export interface PlanTask {
  id: string;
  title: string;
  category: (typeof TASK_CATEGORIES)[number];
  scope: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  /** Names of project commands that verify this task. */
  checks: string[];
  deliverables: string[];
  risk: 'low' | 'medium' | 'high';
  riskFlags: RiskFlag[];
  /** What must be shown for the task to count as complete. */
  evidence: string[];
  /** Requirement ids (FR-n / NFR-n) this task implements. */
  covers: string[];
  entities: string[];
  screens: string[];
}

export interface PlanCommand {
  name: string;
  executable: string;
  args: string[];
  description: string;
}

export interface ProductPlan {
  product: {
    name: string;
    problem: string;
    targetUsers: string[];
    valueProposition: string;
    mvpScope: string[];
    differentiation: string;
    businessModel: string;
    outOfScope: string[];
  };
  requirements: {
    functional: { id: string; title: string; description: string; mvp: boolean; acceptanceCriteria: string[] }[];
    nonFunctional: { id: string; category: string; requirement: string; mvp: boolean }[];
    userStories: { id: string; asA: string; iWant: string; soThat: string; requirementIds: string[]; acceptanceCriteria: string[] }[];
  };
  architecture: {
    projectType: ProjectType;
    platforms: Platform[];
    stack: { layer: string; choice: string; rationale: string; tradeoffs: string; alternatives: string[] }[];
    frontend: string;
    backend: string;
    database: string;
    integrations: { name: string; purpose: string; configKeys: string[]; sensitive: boolean; paid: boolean; verified: boolean }[];
    authentication: string;
    authorization: string;
    deployment: string;
  };
  ux: {
    screens: { id: string; name: string; purpose: string; requirementIds: string[] }[];
    navigation: string;
    journeys: { name: string; steps: string[] }[];
    responsive: string;
    accessibility: string[];
  };
  dataModel: {
    entities: {
      name: string;
      description: string;
      fields: { name: string; type: string; required: boolean; validation: string }[];
      relationships: string[];
      accessControl: string;
      retention: string;
    }[];
  };
  testPlan: { unit: string[]; integration: string[]; browser: string[]; security: string[]; e2e: string[] };
  release: {
    hosting: string;
    environments: string[];
    environmentVariables: { name: string; purpose: string; secret: boolean }[];
    domains: string;
    migrations: string;
    backups: string;
    monitoring: string;
    legal: string[];
    publication: string[];
  };
  commands: PlanCommand[];
  /** Commands run after every task (the factory's validation commands). */
  defaultChecks: string[];
  tasks: PlanTask[];
  statements: Statement[];
  sources: SourceRef[];
  openQuestions: string[];
  feasibility: { feasible: boolean; issues: string[] };
}

const id = (prefix: string) => str({ pattern: new RegExp(`^${prefix}-[0-9]{1,3}$`), label: `must look like ${prefix}-1` });
const reqId = str({ pattern: /^(FR|NFR)-[0-9]{1,3}$/, label: 'must be a requirement id like FR-1 or NFR-1' });
const taskId = str({ pattern: TASK_ID, max: 64, label: 'must be a task id like T1' });
const commandName = str({ pattern: /^[a-z][a-z0-9-]{0,39}$/, label: 'must be a lowercase command name' });

const planTaskCheck: Check<PlanTask> = obj({
  id: taskId,
  title: str({ max: 200 }),
  category: oneOf(TASK_CATEGORIES),
  scope: str({ max: 6000 }),
  dependencies: opt(arr(taskId, { max: 30 }), []),
  acceptanceCriteria: texts(1, 20, 1000),
  checks: arr(commandName, { min: 1, max: 10 }),
  deliverables: texts(1, 20, 500),
  risk: oneOf(['low', 'medium', 'high'] as const),
  riskFlags: opt(arr(oneOf(RISK_FLAGS), { max: RISK_FLAGS.length }), []),
  evidence: texts(1, 10, 1000),
  covers: opt(arr(reqId, { max: 40 }), []),
  entities: opt(arr(str({ max: 80 }), { max: 30 }), []),
  screens: opt(arr(id('SCR'), { max: 30 }), []),
}) as Check<PlanTask>;

export const planCheck: Check<ProductPlan> = obj({
  product: obj({
    name: str({ max: 80 }),
    problem: str({ max: 3000 }),
    targetUsers: texts(1, 20, 500),
    valueProposition: str({ max: 2000 }),
    mvpScope: texts(1, 40),
    differentiation: str({ max: 2000 }),
    businessModel: str({ max: 2000 }),
    outOfScope: opt(texts(0, 40), []),
  }),
  requirements: obj({
    functional: arr(obj({ id: id('FR'), title: str({ max: 200 }), description: str({ max: 3000 }), mvp: bool(), acceptanceCriteria: texts(1, 20, 1000) }), { min: 1, max: 150 }),
    nonFunctional: opt(arr(obj({ id: id('NFR'), category: str({ max: 60 }), requirement: str({ max: 2000 }), mvp: bool() }), { max: 80 }), []),
    userStories: opt(
      arr(obj({ id: id('US'), asA: str({ max: 200 }), iWant: str({ max: 1000 }), soThat: str({ max: 1000 }), requirementIds: arr(reqId, { min: 1, max: 20 }), acceptanceCriteria: texts(1, 20, 1000) }), { max: 150 }),
      [],
    ),
  }),
  architecture: obj({
    projectType: oneOf(PROJECT_TYPES),
    platforms: arr(oneOf(PLATFORMS), { min: 1, max: PLATFORMS.length }),
    stack: arr(obj({ layer: str({ max: 80 }), choice: str({ max: 200 }), rationale: str({ max: 2000 }), tradeoffs: str({ max: 2000 }), alternatives: opt(texts(0, 10, 200), []) }), { min: 1, max: 30 }),
    frontend: str({ max: 2000 }),
    backend: str({ max: 2000 }),
    database: str({ max: 2000 }),
    integrations: opt(
      arr(obj({ name: str({ max: 120 }), purpose: str({ max: 1000 }), configKeys: opt(arr(str({ pattern: /^[A-Z][A-Z0-9_]{0,63}$/, label: 'must be an UPPER_CASE variable name' }), { max: 20 }), []), sensitive: bool(), paid: bool(), verified: opt(bool(), false) }), { max: 30 }),
      [],
    ),
    authentication: str({ max: 2000 }),
    authorization: str({ max: 2000 }),
    deployment: str({ max: 2000 }),
  }),
  ux: obj({
    screens: opt(arr(obj({ id: id('SCR'), name: str({ max: 120 }), purpose: str({ max: 1000 }), requirementIds: opt(arr(reqId, { max: 20 }), []) }), { max: 80 }), []),
    navigation: str({ max: 2000 }),
    journeys: opt(arr(obj({ name: str({ max: 200 }), steps: texts(1, 30, 500) }), { max: 40 }), []),
    responsive: str({ max: 2000 }),
    accessibility: opt(texts(0, 30, 500), []),
  }),
  dataModel: obj({
    entities: opt(
      arr(
        obj({
          name: str({ max: 80, pattern: /^[A-Za-z][A-Za-z0-9_]*$/, label: 'must be an identifier like UserAccount' }),
          description: str({ max: 1000 }),
          fields: arr(obj({ name: str({ max: 80 }), type: str({ max: 80 }), required: bool(), validation: optText(500) }), { min: 1, max: 60 }),
          relationships: opt(texts(0, 20, 300), []),
          accessControl: str({ max: 1000 }),
          retention: str({ max: 1000 }),
        }),
        { max: 60 },
      ),
      [],
    ),
  }),
  testPlan: obj({
    unit: opt(texts(0, 40, 500), []),
    integration: opt(texts(0, 40, 500), []),
    browser: opt(texts(0, 40, 500), []),
    security: opt(texts(0, 40, 500), []),
    e2e: opt(texts(0, 40, 500), []),
  }),
  release: obj({
    hosting: str({ max: 2000 }),
    environments: opt(texts(0, 10, 200), []),
    environmentVariables: opt(arr(obj({ name: str({ pattern: /^[A-Z][A-Z0-9_]{0,63}$/, label: 'must be an UPPER_CASE variable name' }), purpose: str({ max: 500 }), secret: bool() }), { max: 60 }), []),
    domains: str({ max: 1000 }),
    migrations: str({ max: 1000 }),
    backups: str({ max: 1000 }),
    monitoring: str({ max: 1000 }),
    legal: opt(texts(0, 20, 1000), []),
    publication: opt(texts(0, 20, 1000), []),
  }),
  commands: arr(obj({ name: commandName, executable: str({ max: 64 }), args: opt(arr(str({ min: 1, max: 200 }), { max: 20 }), []), description: optText(300) }), { min: 1, max: 10 }),
  defaultChecks: arr(commandName, { min: 1, max: 10 }),
  tasks: arr(planTaskCheck, { min: 1, max: 200 }),
  statements: opt(arr(statementCheck, { max: 120 }), []),
  sources: opt(arr(sourceCheck, { max: 80 }), []),
  openQuestions: opt(texts(0, 40), []),
  feasibility: feasibilityCheck,
}) as Check<ProductPlan>;
