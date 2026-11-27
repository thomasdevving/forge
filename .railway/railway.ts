import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "forge-backend";
export default defineRailway(() => {
  const forgeBackend = service("forge-backend", {
    source: github("thomasdevving/forge", { branch: "main", checkSuites: false }),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "deploy/railway/Dockerfile",
      // redeploy (and restart the fork) only when the backend changes, not for website-only commits
      watchPatterns: [
        "fork/**",
        "services/**",
        "deploy/**",
        "math/**",
        "compiler/**",
        "verifier/**",
        "pyproject.toml",
        "uv.lock",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        ".railway/**",
      ],
    },
    healthcheck: "/health",
    healthcheckTimeout: 600,
    replicas: { "us-west2": 1 },
  });

  return project("forge", {
    variables: { managed: false },
    resources: [forgeBackend],
  });
});
