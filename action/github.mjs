import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";

function requireCommandFile(path, label) {
  if (!path) {
    throw new Error(
      `${label} is unavailable; this entry point must run as a GitHub Action`,
    );
  }
  return path;
}

export function getInput(name, env = process.env) {
  return env[`INPUT_${name.toUpperCase()}`] ?? "";
}

export function getSavedState(name, env = process.env) {
  return env[`STATE_${name}`] ?? "";
}

export async function writeEnvironmentValue(path, name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`invalid GitHub environment-file key: ${name}`);
  }
  const text = String(value);
  let delimiter;
  do {
    delimiter = `fiber_forge_${randomUUID().replaceAll("-", "")}`;
  } while (text.includes(delimiter));
  await appendFile(
    path,
    `${name}<<${delimiter}\n${text}\n${delimiter}\n`,
    "utf8",
  );
}

export async function saveState(name, value, env = process.env) {
  await writeEnvironmentValue(
    requireCommandFile(env.GITHUB_STATE, "GITHUB_STATE"),
    name,
    value,
  );
}

export async function setOutput(name, value, env = process.env) {
  await writeEnvironmentValue(
    requireCommandFile(env.GITHUB_OUTPUT, "GITHUB_OUTPUT"),
    name,
    value,
  );
}

function escapeWorkflowCommand(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export function errorAnnotation(message) {
  console.error(`::error::${escapeWorkflowCommand(message)}`);
}

export function noticeAnnotation(message) {
  console.log(`::notice::${escapeWorkflowCommand(message)}`);
}
