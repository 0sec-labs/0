import { describe, expect, it } from "vitest";
import { allowlistedChildEnv, sanitizedEnv } from "./sanitized-env.js";

describe("allowlistedChildEnv", () => {
  it("carries only allowlisted basics from the parent env", () => {
    const env = allowlistedChildEnv({}, {
      PATH: "/usr/bin",
      HOME: "/home/x",
      GITHUB_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      OPENAI_API_KEY: "sk-x",
      MY_CUSTOM_VAR: "keepme",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // Non-allowlisted vars never flow through unless passed as extras.
    expect(env.MY_CUSTOM_VAR).toBeUndefined();
  });

  it("merges caller extras", () => {
    const env = allowlistedChildEnv({ "ZERO_TARGET": "https://t.example" }, { PATH: "/bin" });
    expect(env["ZERO_TARGET"]).toBe("https://t.example");
    expect(env.PATH).toBe("/bin");
  });

  it("still screens extras against sensitive patterns", () => {
    const env = allowlistedChildEnv({ GITHUB_TOKEN: "leak" }, { PATH: "/bin" });
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("sanitizedEnv denylist still filters known secrets (defense in depth)", () => {
    const env = sanitizedEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-ant-x",
      "ZERO_CLOUD_TOKEN": "tok",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env["ZERO_CLOUD_TOKEN"]).toBeUndefined();
  });
});

describe("newly covered credential shapes", () => {
  // These names are read by the runtime/intel/verify lanes but were absent from
  // SENSITIVE_ENV_PATTERNS. The allowlist already dropped them from the parent
  // copy; this pins the `extras` path too, so a caller cannot reintroduce one.
  it.each([
    ["QWEN_API_KEY", "qwen-secret"],
    ["NVD_API_KEY", "nvd-secret"],
    ["E2B_API_KEY", "e2b-secret"],
    ["ZERO_LLM_TARGET_KEY", "target-secret"],
  ])("screens %s out of caller extras", (name, value) => {
    const env = allowlistedChildEnv({ [name]: value }, { PATH: "/bin" });
    expect(env[name]).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("does not carry them from the parent environment either", () => {
    const env = allowlistedChildEnv({}, {
      PATH: "/bin",
      QWEN_API_KEY: "q",
      NVD_API_KEY: "n",
      E2B_API_KEY: "e",
      "ZERO_LLM_TARGET_KEY": "t",
    });
    expect(Object.keys(env)).toEqual(["PATH", "ZERO_AGENT_SESSION"]);
  });
});

describe("generic credential-shape screening (extras path)", () => {
  // Names that no vendor-specific pattern anticipated but every generic shape
  // should catch. Each is a real credential envelope the task called out.
  it.each([
    ["NVD_CREDS", "generic CRED shape"],
    ["MY_COMPANY_APIKEY", "APIKEY with no separator"],
    ["GH_PAT", "personal access token (_PAT)"],
    ["AWS_SESSION_TOKEN", "generic TOKEN shape"],
    ["AWS_ACCESS_KEY_ID", "ACCESS_KEY shape"],
    ["AWS_SECRET_ACCESS_KEY", "SECRET shape"],
    ["DATABASE_PASSWORD", "PASSWORD shape"],
    ["SSH_PASSPHRASE", "PASSPHRASE shape"],
    ["MY_PRIVATE_KEY", "PRIVATE_KEY shape"],
    ["SERVICE_CLIENT_SECRET", "SECRET shape"],
    ["SOME_BEARER_TOKEN", "BEARER shape"],
    ["VENDOR_AUTH_TOKEN", "AUTH_TOKEN shape"],
  ])("screens %s out of caller extras (%s)", (name) => {
    const env = allowlistedChildEnv({ [name]: "leak" }, { PATH: "/bin" });
    expect(env[name]).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("matches credential shapes case-insensitively", () => {
    const env = allowlistedChildEnv(
      { github_token: "leak", Aws_Session_Token: "leak", api_key: "leak" },
      { PATH: "/bin" },
    );
    expect(env.github_token).toBeUndefined();
    expect(env.Aws_Session_Token).toBeUndefined();
    expect(env.api_key).toBeUndefined();
  });

  it("does not over-block: PATH is not treated as a _PAT credential", () => {
    // "PATH".includes("PAT") is true, but the pattern is "_PAT" (underscore),
    // so a legitimate PATH extra survives.
    const env = allowlistedChildEnv({ PATH: "/opt/bin" }, {});
    expect(env.PATH).toBe("/opt/bin");
  });

  it("still passes the non-secret child-runtime extras callers rely on", () => {
    // Regression guard: the block-net flag, verify marker, scan id and target
    // must NOT be caught by the widened patterns.
    const env = allowlistedChildEnv(
      {
        "ZERO_KERNEL_BLOCK_NET": "1",
        "ZERO_VERIFY": "1",
        TARGET: "https://t.example",
      },
      { PATH: "/bin" },
    );
    expect(env["ZERO_KERNEL_BLOCK_NET"]).toBe("1");
    expect(env["ZERO_VERIFY"]).toBe("1");
    expect(env.TARGET).toBe("https://t.example");
  });
});

describe("Together AI credentials", () => {
  it("never reaches an agent-controlled child, inherited or injected", () => {
    const parent = { PATH: "/bin", TOGETHER_API_KEY: "synthetic-together-secret", TOGETHER_BASE_URL: "https://api.together.ai/v1" };
    expect(JSON.stringify(sanitizedEnv(parent))).not.toContain("synthetic-together-secret");
    expect(sanitizedEnv(parent)).toEqual({ PATH: "/bin", ZERO_AGENT_SESSION: "1" });
    const injected = allowlistedChildEnv({ TOGETHER_API_KEY: "synthetic-together-secret", together_api_key: "synthetic-together-secret" }, { PATH: "/bin" });
    expect(injected).toEqual({ PATH: "/bin", ZERO_AGENT_SESSION: "1" });
  });
});

describe("bash child environment override", () => {
  const parent = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x", GITHUB_TOKEN: "ghp_x", AWS_SECRET_ACCESS_KEY: "aws", CUSTOM_BUILD_FLAG: "1" };
  it("strips provider keys and tokens by default", () => {
    expect(sanitizedEnv(parent)).toEqual({ PATH: "/bin", ZERO_AGENT_SESSION: "1" });
  });
  it("ZERO_BASH_ENV_ALLOW adds exactly the named variables", () => {
    const env = sanitizedEnv({ ...parent, ZERO_BASH_ENV_ALLOW: "CUSTOM_BUILD_FLAG, not a name,GITHUB_TOKEN" });
    expect(env.CUSTOM_BUILD_FLAG).toBe("1");
    expect(env.GITHUB_TOKEN).toBe("ghp_x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
  it("ZERO_BASH_ENV_PASSTHROUGH_ALL=1 turns the allowlist off", () => {
    expect(sanitizedEnv({ ...parent, ZERO_BASH_ENV_PASSTHROUGH_ALL: "1" }).ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(sanitizedEnv({ ...parent, ZERO_BASH_ENV_PASSTHROUGH_ALL: "yes" }).ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("agent session marker", () => {
  it("is set in every child environment, including passthrough and extras", () => {
    expect(sanitizedEnv({ PATH: "/bin" }).ZERO_AGENT_SESSION).toBe("1");
    expect(sanitizedEnv({ PATH: "/bin", ZERO_BASH_ENV_PASSTHROUGH_ALL: "1", ZERO_AGENT_SESSION: "0" }).ZERO_AGENT_SESSION).toBe("1");
    expect(allowlistedChildEnv({ ZERO_AGENT_SESSION: "" }, { PATH: "/bin" }).ZERO_AGENT_SESSION).toBe("1");
  });
});

describe("0 CLI discovery from a shell child", () => {
  it("passes HOME and ZERO_DB_PATH so `0` inside bash finds the running console", () => {
    const env = sanitizedEnv({ PATH: "/bin", HOME: "/home/u", ZERO_DB_PATH: "/home/u/.0/0.db", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(env.HOME).toBe("/home/u");
    expect(env.ZERO_DB_PATH).toBe("/home/u/.0/0.db");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
