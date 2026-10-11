import { ValidationError } from '../core/errors.js';
import { isRecord, readString, readStringArray, type Issues } from '../core/validation.js';

/** The approved product idea / specification the factory works from. */
export interface ProjectSpec {
  id: string;
  name: string;
  description: string;
  goals: string[];
  constraints: string[];
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseProjectSpec(raw: unknown): ProjectSpec {
  if (!isRecord(raw)) throw new ValidationError('Project spec must be a JSON object');
  const issues: Issues = [];
  const id = readString(raw, 'id', 'project', issues);
  if (id !== undefined && !PROJECT_ID.test(id)) issues.push(`project.id must match ${PROJECT_ID}`);
  const name = readString(raw, 'name', 'project', issues, { maxLength: 200 });
  const description = readString(raw, 'description', 'project', issues, { maxLength: 20_000 });
  const goals = readStringArray(raw, 'goals', 'project', issues, { optional: true }) ?? [];
  const constraints = readStringArray(raw, 'constraints', 'project', issues, { optional: true }) ?? [];
  if (issues.length > 0) throw new ValidationError('Invalid project spec', issues);
  return { id: id!, name: name!, description: description!, goals, constraints };
}
