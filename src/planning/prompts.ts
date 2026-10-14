import type { PlannerRequest } from './planner.js';

/**
 * Prompts for the planner. The answer must be one JSON object; the factory
 * validates it strictly and renders every document from it, so the model never
 * writes files or chooses limits, permissions or budgets.
 */

const HONESTY = [
  'Honesty rules (mandatory):',
  '- Label every statement in "statements" with its basis: "user-provided" (the user said it), "verified" (you checked it in a source listed in "sources"), "assumption" (unverified), or "recommendation" (your advice).',
  '- Never invent citations, competitor data, prices, market statistics, API capabilities or legal conclusions. If you did not check it, it is an assumption.',
  '- Sources: kind "user-supplied" for material the user gave, "codebase" for files you read, "web" only for pages you actually retrieved in this session (with the URL and retrievedAt date).',
  '- Do not include secrets, API keys, passwords or tokens anywhere.',
].join('\n');

function ideaBlock(request: PlannerRequest): string {
  const i = request.idea;
  const field = (label: string, value: string) => (value.trim() ? `${label}: ${value.trim()}` : `${label}: (not provided - choose a reasonable default and record it as an assumption)`);
  return [
    '## The idea (user-provided)',
    `Name: ${i.name}`,
    `Idea and problem: ${i.idea}`,
    field('Target users', i.targetUsers),
    field('Market', i.market),
    field('Business model and monetization', i.businessModel),
    `Preferred platforms: ${i.platforms.length ? i.platforms.join(', ') : '(not provided - recommend)'}`,
    field('Constraints', i.constraints),
    field('Budget limits', i.budget),
    field('Preferred technologies', i.preferredTech),
    i.referenceUrls.length ? `Reference URLs (user-supplied; not retrieved unless you have web tools): ${i.referenceUrls.join(', ')}` : '',
    i.research.trim() ? `\n### Research and notes supplied by the user\n${i.research.trim()}` : '',
    i.clarifications.length ? `\n### Answers to your earlier questions\n${i.clarifications.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function contextBlock(request: PlannerRequest, webResearch: boolean): string {
  const lines = [
    `Today is ${request.today}.`,
    webResearch
      ? 'You may use WebSearch and WebFetch for research. Record every page you used as a "web" source with its URL and retrievedAt date.'
      : 'Live research is NOT available in this session. Do not claim any external fact as verified; use "assumption".',
  ];
  const c = request.codebase;
  if (c !== undefined) {
    lines.push(
      '',
      '## Existing codebase (extend it; do not rewrite it)',
      `Your working directory is the codebase. You may read files with Read, Glob and Grep. Git: ${c.isGitRepo ? `branch ${c.branch ?? '(detached)'}, ${c.uncommittedChanges} uncommitted change(s)` : 'not a git repository'}.`,
      `Top level: ${c.topLevel.join(', ')}`,
      `Files by extension: ${Object.entries(c.fileCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([e, n]) => `${e}=${n}`).join(', ')}`,
      c.packageJson ? `package.json: scripts ${c.packageJson.scripts.join(', ') || 'none'}; dependencies ${c.packageJson.dependencies.slice(0, 40).join(', ') || 'none'}` : 'No package.json.',
      'Cite files you relied on as "codebase" sources (url = relative file path).',
    );
  }
  return lines.join('\n');
}

const COMMAND_RULES = [
  'Validation commands (the factory runs them after every task, without a shell, on Windows):',
  '- Allowed forms only: {"executable":"node","args":["--test", ...test files or globs]} or {"executable":"node","args":["--run","<package.json script name>"]}.',
  '- Never install packages, publish, deploy or log in. Dependencies are installed by a person once in the project root; tests and scripts find them from there.',
  '- The first task must create package.json (or the platform equivalent) with the scripts the commands use, so the checks can run from the start.',
].join('\n');

export function proposalPrompt(request: PlannerRequest, webResearch: boolean): string {
  return [
    'You are the product planner of an AI software factory. Prepare a concise product PROPOSAL for the idea below so a person can approve or reject it.',
    'Do not write any files. Answer with ONE JSON object only (no prose), in a ```json block.',
    '',
    ideaBlock(request),
    '',
    contextBlock(request, webResearch),
    '',
    HONESTY,
    '',
    'Rules:',
    '- Keep the MVP small and shippable. Choose a stack that fits the product (do not default to one framework); prefer well-supported, low-cost options.',
    '- Only set "blockingQuestion" if planning genuinely cannot continue without the answer; otherwise choose a default and record it as an assumption.',
    '- If the idea is not feasible as described, set feasibility.feasible=false and explain; never silently substitute a different product.',
    '- recurringCosts: include hosting, databases and paid APIs with honest estimates labelled by basis.',
    request.previousIssues.length ? `\nYour previous answer had these problems; fix all of them:\n- ${request.previousIssues.slice(0, 40).join('\n- ')}` : '',
    '',
    'JSON shape:',
    '{"productName":"","summary":"","problem":"","targetUsers":[""],"valueProposition":"","projectType":"web-app|saas|api|mobile|desktop|existing-codebase","platforms":["website|saas|android|ios|desktop|api"],"mvpScope":[""],"outOfScope":[""],"effort":{"estimatedTasks":12,"complexity":"small|medium|large","notes":""},"recurringCosts":[{"item":"","estimate":"","basis":"assumption","notes":""}],"risks":[{"risk":"","severity":"low|medium|high","mitigation":""}],"statements":[{"statement":"","basis":"user-provided|verified|assumption|recommendation","sourceIds":["SRC-1"]}],"sources":[{"id":"SRC-1","title":"","kind":"user-supplied|web|codebase","url":"","retrievedAt":"","notes":""}],"openQuestions":[""],"blockingQuestion":"","feasibility":{"feasible":true,"issues":[]}}',
  ].filter((l) => l !== '').join('\n');
}

export function finalizePrompt(request: PlannerRequest, webResearch: boolean): string {
  return [
    'You are the product planner of an AI software factory. The person APPROVED the proposal below. Produce the complete PLAN: product, requirements, architecture, UX, data model, test plan, release plan, validation commands and the development backlog.',
    'Do not write any files. Answer with ONE JSON object only (no prose), in a ```json block. The factory renders PRODUCT.md, REQUIREMENTS.md, ARCHITECTURE.md, UX_PLAN.md, DATA_MODEL.md, TEST_PLAN.md, RELEASE_PLAN.md and TASKS.json from it.',
    '',
    ideaBlock(request),
    '',
    '## Approved proposal',
    JSON.stringify(request.proposal),
    '',
    contextBlock(request, webResearch),
    '',
    HONESTY,
    '',
    'Consistency rules (the factory rejects the plan otherwise):',
    '- Ids: requirements FR-1.. and NFR-1.., user stories US-1.., screens SCR-1.., sources SRC-1.., tasks T1, T2, ...',
    '- Every MVP requirement is covered by at least one task ("covers"). Every data-model entity is implemented by a task ("entities"). Every screen is built by a task ("screens").',
    '- Every integration lists its configuration keys, and each key appears in release.environmentVariables. Never include values.',
    '- Tasks: small, independently verifiable, observable acceptance criteria, real dependencies only (no cycles), checks naming defined commands, deliverables, risk (low|medium|high) with riskFlags, and completion evidence. Tasks flagged authentication, authorization, payments, secrets, data-deletion, migration, deployment, paid-resource or legal must be medium or high risk.',
    '- Include foundation (repository setup, configuration), data layer, authentication if needed, core features, integration, automated tests, security hardening and release preparation as the product needs. Release tasks prepare documentation and configuration only; they never deploy, publish or buy anything.',
    '- Do not pad the backlog: prefer meaningful tasks. Do not silently drop requirements that are hard; keep them and record the risk.',
    '- Stay within the approved product; if it turns out infeasible, set feasibility.feasible=false and explain.',
    `- Use the existing codebase's structure and conventions${request.codebase ? '' : ' (not applicable: this is a new project)'}.`,
    '',
    COMMAND_RULES,
    request.previousIssues.length ? `\nYour previous answer had these problems; fix all of them:\n- ${request.previousIssues.slice(0, 60).join('\n- ')}` : '',
    '',
    'JSON shape:',
    '{"product":{"name":"","problem":"","targetUsers":[""],"valueProposition":"","mvpScope":[""],"differentiation":"","businessModel":"","outOfScope":[""]},',
    '"requirements":{"functional":[{"id":"FR-1","title":"","description":"","mvp":true,"acceptanceCriteria":[""]}],"nonFunctional":[{"id":"NFR-1","category":"security|performance|accessibility|...","requirement":"","mvp":true}],"userStories":[{"id":"US-1","asA":"","iWant":"","soThat":"","requirementIds":["FR-1"],"acceptanceCriteria":[""]}]},',
    '"architecture":{"projectType":"","platforms":[""],"stack":[{"layer":"","choice":"","rationale":"","tradeoffs":"","alternatives":[""]}],"frontend":"","backend":"","database":"","integrations":[{"name":"","purpose":"","configKeys":["API_KEY_NAME"],"sensitive":true,"paid":false,"verified":false}],"authentication":"","authorization":"","deployment":""},',
    '"ux":{"screens":[{"id":"SCR-1","name":"","purpose":"","requirementIds":["FR-1"]}],"navigation":"","journeys":[{"name":"","steps":[""]}],"responsive":"","accessibility":[""]},',
    '"dataModel":{"entities":[{"name":"EntityName","description":"","fields":[{"name":"","type":"","required":true,"validation":""}],"relationships":[""],"accessControl":"","retention":""}]},',
    '"testPlan":{"unit":[""],"integration":[""],"browser":[""],"security":[""],"e2e":[""]},',
    '"release":{"hosting":"","environments":[""],"environmentVariables":[{"name":"","purpose":"","secret":true}],"domains":"","migrations":"","backups":"","monitoring":"","legal":[""],"publication":[""]},',
    '"commands":[{"name":"test","executable":"node","args":["--test"],"description":""}],"defaultChecks":["test"],',
    '"tasks":[{"id":"T1","title":"","category":"foundation|feature|integration|testing|security|release","scope":"","dependencies":[],"acceptanceCriteria":[""],"checks":["test"],"deliverables":[""],"risk":"low","riskFlags":[],"evidence":[""],"covers":["FR-1"],"entities":[""],"screens":["SCR-1"]}],',
    '"statements":[],"sources":[],"openQuestions":[],"feasibility":{"feasible":true,"issues":[]}}',
  ].filter((l) => l !== '').join('\n');
}
