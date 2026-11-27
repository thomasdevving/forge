import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "forge-backend";
export default defineRailway(() => {
  const forgeBackend = service("forge-backend", {
    source: github("thomasdevving/forge", { branch: "main", checkSuites: false }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "deploy/railway/Dockerfile" },
    healthcheck: "/health",
    healthcheckTimeout: 600,
    replicas: { "us-west2": 1 },
  });

  return project("forge", {
    variables: { managed: false },
    resources: [forgeBackend],
  });
});
