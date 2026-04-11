const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");

function loadDependencies() {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return Object.keys(pkg.dependencies || {});
}

function findMissingPackages(packages) {
  const missing = [];
  for (const pkgName of packages) {
    try {
      require.resolve(pkgName, { paths: [projectRoot] });
    } catch (_) {
      missing.push(pkgName);
    }
  }
  return missing;
}

function main() {
  try {
    const quiet = process.argv.includes("--quiet");
    const deps = loadDependencies();
    const missing = findMissingPackages(deps);

    if (missing.length > 0) {
      console.log(`[DEPENDENCY] Missing: ${missing.join(", ")}`);
      process.exit(1);
    }

    if (!quiet) {
      console.log("[DEPENDENCY] PASS all runtime packages are available");
    }
  } catch (error) {
    console.error(`[DEPENDENCY] CHECK FAILED ${error.message}`);
    process.exit(2);
  }
}

main();
