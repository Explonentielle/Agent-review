import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const gitlab = { GITLAB_URL: "https://gitlab.example/", GITLAB_TOKEN: "jeton-gitlab", GITLAB_USERNAME: "alex" };
const github = { GITHUB_TOKEN: "jeton-github" };
const machine = { DATA_DIR: "/tmp/review-agent-test", CLAUDE_BIN: "/bin/false" };

describe("configuration de la machine : forges", () => {
  it("GitLab seul, comme avant : adresse sans barre finale, GitHub absent, détection toutes les 90 s", () => {
    const config = loadConfig({ ...machine, ...gitlab });

    expect(config.gitlab).toEqual({ url: "https://gitlab.example", token: "jeton-gitlab", username: "alex" });
    expect(config.github).toBeNull();
    expect(config.pollIntervalMs).toBe(90_000);
  });

  it("GitHub seul : l'adresse de l'API par défaut est celle de github.com", () => {
    const config = loadConfig({ ...machine, ...github });

    expect(config.gitlab).toBeNull();
    expect(config.github).toEqual({ apiUrl: "https://api.github.com", token: "jeton-github" });
  });

  it("les deux forges ensemble, avec une adresse d'API propre à GitHub Enterprise", () => {
    const config = loadConfig({ ...machine, ...gitlab, ...github, GITHUB_API_URL: "https://git.entreprise.example/api/v3", POLL_INTERVAL_SEC: "120" });

    expect(config.gitlab?.username).toBe("alex");
    expect(config.github).toEqual({ apiUrl: "https://git.entreprise.example/api/v3", token: "jeton-github" });
    expect(config.pollIntervalMs).toBe(120_000);
  });

  it("une variable laissée vide dans le .env vaut « non renseignée »", () => {
    const config = loadConfig({ ...machine, ...gitlab, GITHUB_TOKEN: "", GITHUB_API_URL: "  " });

    expect(config.github).toBeNull();
    const empty = loadConfig({ ...machine, GITLAB_URL: "", GITLAB_TOKEN: "", GITLAB_USERNAME: "", GITHUB_TOKEN: "" });
    expect(empty.gitlab).toBeNull();
    expect(empty.gitlabUrl).toBeNull();
  });

  it("GitLab à moitié renseigné : chaque variable manquante est signalée, sans afficher les valeurs", () => {
    expect(() => loadConfig({ ...machine, GITLAB_URL: "https://gitlab.example", GITLAB_TOKEN: "jeton", ...github })).toThrow(/GITLAB_USERNAME manquant/);
    expect(() => loadConfig({ ...machine, GITLAB_URL: "https://gitlab.example", GITLAB_USERNAME: "alex", ...github })).toThrow(/GITLAB_TOKEN manquant/);
    const error = (() => {
      try {
        loadConfig({ ...machine, GITLAB_TOKEN: "jeton-gitlab-secret" });
      } catch (err) {
        return String(err);
      }
      return "";
    })();
    expect(error).toContain("GITLAB_URL manquant");
    expect(error).not.toContain("jeton-gitlab-secret");
  });

  it("GITLAB_URL seule : suffit au démarrage, le jeton GitLab se saisit ensuite dans le dashboard", () => {
    const config = loadConfig({ ...machine, GITLAB_URL: "https://gitlab.example/", ...github });
    expect(config.gitlab).toBeNull();
    expect(config.gitlabUrl).toBe("https://gitlab.example");
    expect(loadConfig({ ...machine, ...gitlab }).gitlabUrl).toBe("https://gitlab.example");
    expect(loadConfig({ ...machine, ...github }).gitlabUrl).toBeNull();

    const alone = loadConfig({ ...machine, GITLAB_URL: "https://gitlab.example" });
    expect(alone.gitlab).toBeNull();
    expect(alone.github).toBeNull();
    expect(alone.gitlabUrl).toBe("https://gitlab.example");
  });

  it("aucune forge dans le .env : l'outil démarre, adresse et jetons se saisissent dans le dashboard", () => {
    const config = loadConfig({ ...machine });
    expect(config.gitlab).toBeNull();
    expect(config.github).toBeNull();
    expect(config.gitlabUrl).toBeNull();
    expect(config.githubApiUrl).toBe("https://api.github.com");
  });

  it("valeurs invalides : adresse, intervalle trop court", () => {
    expect(() => loadConfig({ ...machine, ...gitlab, GITLAB_URL: "pas-une-adresse" })).toThrow("GITLAB_URL");
    expect(() => loadConfig({ ...machine, ...github, GITHUB_API_URL: "pas-une-adresse" })).toThrow("GITHUB_API_URL");
    expect(() => loadConfig({ ...machine, ...gitlab, POLL_INTERVAL_SEC: "10" })).toThrow("POLL_INTERVAL_SEC");
  });
});
