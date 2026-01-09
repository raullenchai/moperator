/**
 * Email Labeler
 *
 * Uses Claude to assign labels to incoming emails based on content analysis.
 * Replaces the old single-agent routing with multi-label classification.
 */

import type { Label, ParsedEmail, LabelingDecision, ClaudeResponse } from "./types";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-3-5-haiku-latest";

/**
 * Label an email using Claude. Returns one or more labels based on email content.
 */
export async function labelEmail(
  email: ParsedEmail,
  labels: Label[],
  apiKey: string
): Promise<LabelingDecision> {
  const startTime = Date.now();

  // Must have at least catch-all
  if (labels.length === 0) {
    return { labels: ["catch-all"], reason: "No labels defined" };
  }

  // If only catch-all exists, use it directly
  if (labels.length === 1 && labels[0].id === "catch-all") {
    return { labels: ["catch-all"], reason: "Only catch-all label available" };
  }

  const prompt = buildLabelingPrompt(email, labels);

  const response = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  console.log(`[LABELER] Claude API took ${Date.now() - startTime}ms`);

  if (!response.ok) {
    console.error("[LABELER] Claude API error:", await response.text());
    return { labels: ["catch-all"], reason: "Labeling failed, using catch-all" };
  }

  const data = (await response.json()) as ClaudeResponse;
  const text = data.content[0]?.text || "";

  return parseLabelingResponse(text, labels);
}

/**
 * Build the labeling prompt for Claude
 */
export function buildLabelingPrompt(email: ParsedEmail, labels: Label[]): string {
  const labelList = labels
    .map((l) => `- ${l.id}: ${l.description.slice(0, 150)}`)
    .join("\n");

  return `Classify this email with one or more labels. An email CAN have multiple labels if relevant.
Always include at least one label. Use "catch-all" only if no other labels apply.

Reply with JSON only: {"labels":["label1","label2"],"reason":"brief explanation"}

Email:
From: ${email.from}
Subject: ${email.subject}
Body: ${email.textBody.slice(0, 500)}

Available labels:
${labelList}`;
}

/**
 * Parse Claude's labeling response
 */
export function parseLabelingResponse(text: string, labels: Label[]): LabelingDecision {
  const validIds = new Set(labels.map((l) => l.id));

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { labels?: string[]; reason?: string };

      if (Array.isArray(parsed.labels) && parsed.labels.length > 0) {
        // Filter to only valid label IDs
        const validLabels = parsed.labels.filter((id) => validIds.has(id));

        if (validLabels.length > 0) {
          return {
            labels: validLabels,
            reason: parsed.reason || "Classified by AI",
          };
        }
      }
    }
  } catch {
    console.error("[LABELER] Failed to parse response:", text);
  }

  // Fallback to catch-all
  return { labels: ["catch-all"], reason: "Parse failed, using catch-all" };
}

// Re-export legacy function for backwards compatibility
export { labelEmail as routeEmail };
