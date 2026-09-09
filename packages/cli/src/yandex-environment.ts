import type { OutputReader } from "./commands.ts";

const YC_INSTALL_URL = "https://yandex.cloud/en/docs/cli/quickstart#install";

export async function yandexDeployerSubjectFor(
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
): Promise<string> {
  const configured = environment.YC_SUBJECT?.trim()
    || environment.TF_VAR_deployer_subject?.trim();
  if (configured) {
    if (!/^(?:userAccount|serviceAccount|federatedUser):[A-Za-z0-9_-]+$/.test(configured)) {
      throw new Error("YC_SUBJECT must use userAccount:<id>, serviceAccount:<id>, or federatedUser:<id> format.");
    }
    return configured;
  }

  let id: string;
  try {
    id = (await readCommand("yc", ["iam", "whoami"], environment)).trim();
  } catch (cause) {
    throw deployerSubjectError(cause);
  }
  if (!id) throw deployerSubjectError();

  try {
    const serviceAccount = JSON.parse(await readCommand(
      "yc", ["iam", "service-account", "get", "--id", id, "--format", "json"], environment,
    )) as { id?: string };
    if (serviceAccount.id === id) return `serviceAccount:${id}`;
  } catch {
    // The active subject is a user; inspect it below to distinguish federated users.
  }

  try {
    const userAccount = JSON.parse(await readCommand(
      "yc", ["iam", "user-account", "get", "--id", id, "--format", "json"], environment,
    )) as { id?: string, federated_user_account?: unknown };
    if (userAccount.id !== id) throw new Error("YC returned a different user account");
    return `${userAccount.federated_user_account ? "federatedUser" : "userAccount"}:${id}`;
  } catch (cause) {
    throw deployerSubjectError(cause);
  }
}

function deployerSubjectError(cause?: unknown): Error {
  return new Error([
    "Could not identify the Yandex Cloud subject running Terraform.",
    "Authenticate with yc init, or set YC_SUBJECT to userAccount:<id>, serviceAccount:<id>, or federatedUser:<id>.",
  ].join("\n"), cause === undefined ? undefined : { cause });
}

export async function yandexEnvironmentFor(
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
) {
  const result: NodeJS.ProcessEnv = {
    ...environment,
  };
  const requiredConfiguration = ["YC_TOKEN", "YC_CLOUD_ID"];
  const missingYandexConfiguration = requiredConfiguration
    .some((name) => !result[name]?.trim());
  if (missingYandexConfiguration) {
    try {
      await readCommand("yc", ["version"], result);
    } catch (cause) {
      throw new Error([
        "Yandex Cloud CLI (yc) was not found.",
        `Install it: ${YC_INSTALL_URL}`,
        "Then authenticate with: yc init",
        "Alternatively, set YC_TOKEN to a valid IAM token.",
      ].join("\n"), { cause });
    }
  }
  if (!result.YC_TOKEN?.trim()) {
    let token: string;
    try {
      token = (await readCommand("yc", ["iam", "create-token"], result)).trim();
    } catch (cause) {
      throw new Error([
        "Could not obtain an IAM token from Yandex Cloud CLI.",
        "Authenticate with: yc init",
        "Then retry the Vibecloud command, or set YC_TOKEN to a valid IAM token.",
      ].join("\n"), { cause });
    }
    if (!token) {
      throw new Error([
        "Yandex Cloud CLI returned an empty IAM token.",
        "Authenticate again with: yc init",
        "Then retry the Vibecloud command, or set YC_TOKEN to a valid IAM token.",
      ].join("\n"));
    }
    result.YC_TOKEN = token;
  }
  if (!result.YC_CLOUD_ID?.trim()) {
    result.YC_CLOUD_ID = await readYandexProfileValue(
      "cloud-id", "YC_CLOUD_ID", "cloud ID", result, readCommand,
    );
  }
  return result;
}

async function readYandexProfileValue(
  property: "cloud-id",
  environmentName: "YC_CLOUD_ID",
  label: string,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
) {
  let value: string;
  try {
    value = (await readCommand("yc", ["config", "get", property], environment)).trim();
  } catch (cause) {
    throw new Error([
      `Could not obtain the active ${label} from Yandex Cloud CLI.`,
      "Configure the active profile with: yc init",
      `Then retry the Vibecloud command, or set ${environmentName}.`,
    ].join("\n"), { cause });
  }
  if (!value) {
    throw new Error([
      `Yandex Cloud CLI returned an empty ${label}.`,
      "Configure the active profile with: yc init",
      `Then retry the Vibecloud command, or set ${environmentName}.`,
    ].join("\n"));
  }
  return value;
}
