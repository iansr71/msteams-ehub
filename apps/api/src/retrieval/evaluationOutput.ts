import { redactString, sanitizeText } from '@ehub/shared';

import type { CaseResult, EvaluationReport } from './evaluationRunner.js';

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

function caseLines(result: CaseResult): string[] {
  const lines = [
    `${result.passed ? 'PASS' : 'FAIL'} ${result.id}${result.failures.length === 0 ? '' : ` (${result.failures.join(', ')})`}${result.firstExpectedRank === undefined ? '' : ` first expected at rank ${String(result.firstExpectedRank)}`}`,
  ];
  if (result.error !== undefined) {
    lines.push(`    error: ${sanitizeText(result.error, 200)}`);
  }
  for (const chunk of result.results) {
    const marks = [
      chunk.expected ? 'expected' : undefined,
      chunk.forbidden ? 'FORBIDDEN' : undefined,
      chunk.authorized ? undefined : 'UNAUTHORISED COURSE',
    ].filter((mark) => mark !== undefined);
    lines.push(
      `    ${String(chunk.rank).padStart(2)}. course ${String(chunk.courseId)} | resource ${chunk.resourceId} | score ${chunk.score.toFixed(4)}${chunk.rerankerScore === undefined ? '' : ` | reranker ${chunk.rerankerScore.toFixed(2)}`}${marks.length === 0 ? '' : ` [${marks.join(', ')}]`}`,
      `        ${chunk.resourceName} > ${chunk.title}`,
    );
    if (chunk.excerpt !== undefined) {
      lines.push(`        excerpt (untrusted source text): ${chunk.excerpt}`);
    }
  }
  return lines;
}

export function renderEvaluationText(report: EvaluationReport): string {
  const { summary } = report;
  const lines = report.cases.flatMap(caseLines);
  lines.push(
    '',
    `Cases: ${String(summary.cases)} | passed ${String(summary.passed)} | failed ${String(summary.failed)} | errors ${String(summary.errored)}`,
    `Scored cases (with expected resources): ${String(summary.scoredCases)}`,
    `Hit@1 ${percent(summary.hitAt1)} | Hit@3 ${percent(summary.hitAt3)} | Hit@5 ${percent(summary.hitAt5)} | MRR ${summary.meanReciprocalRank.toFixed(3)}`,
  );
  return redactString(lines.join('\n'));
}

export function renderEvaluationJson(report: EvaluationReport): string {
  return redactString(JSON.stringify(report, null, 2));
}
