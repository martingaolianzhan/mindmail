import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mailPath = fileURLToPath(new URL("../../src/app/mail/", import.meta.url));
const editorPath = join(mailPath, "components/email-editor/email-editor.tsx");
const composePath = join(mailPath, "components/ai-compose/ai-compose-botton.tsx");
const serverActionsPath = join(mailPath, "components/ai-compose/ai-actions.ts");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("UI-005 mail AI execution UI removal", () => {
  it("removes AI controls, shortcuts, hints and insertion plumbing from the shared editor", () => {
    const source = readFileSync(editorPath, "utf8");
    for (const forbidden of [
      "AIComposeBotton", "AI Smart Compose", "autoAIComplete", "generateEmail",
      "readStreamableValue", "Meta-j", "Control-j", "Cmd + J", "AI autocomplete",
      "onGenerate", "setSnippet",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("deletes the unused AI Smart Compose button/dialog component", () => {
    expect(existsSync(composePath)).toBe(false);
  });

  it("leaves no mail UI consumer of AI actions or the removed compose component", () => {
    // Server AI implementation is deliberately outside UI-005's removal scope.
    for (const path of sourceFiles(mailPath).filter(path => path !== serverActionsPath)) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(
        /AIComposeBotton|AI Smart Compose|ai-compose-botton|ai-actions|\b(?:generateEmail|autoAIComplete|readStreamableValue)\b|Meta-j|Control-j|Cmd \+ J|AI autocomplete/,
      );
    }
  });
});
