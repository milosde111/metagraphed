import Ajv2020 from "ajv/dist/2020.js";
import path from "node:path";
import {
  loadCandidates,
  loadProviders,
  loadSubnets,
  readJson,
  repoRoot
} from "./lib.mjs";

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: false
});

const providerSchema = await readJson(path.join(repoRoot, "schemas/provider.schema.json"));
const subnetSchema = await readJson(path.join(repoRoot, "schemas/subnet-manifest.schema.json"));
const candidateSchema = await readJson(path.join(repoRoot, "schemas/candidate-surface.schema.json"));
const publicArtifactsSchema = await readJson(path.join(repoRoot, "schemas/public-artifacts.schema.json"));

for (const schema of [providerSchema, subnetSchema, candidateSchema, publicArtifactsSchema]) {
  ajv.addSchema(schema, schema.$id);
}

const validators = {
  provider: ajv.getSchema(providerSchema.$id),
  subnet: ajv.getSchema(subnetSchema.$id),
  candidate: ajv.getSchema(candidateSchema.$id),
  artifacts: ajv.getSchema(publicArtifactsSchema.$id)
};

const errors = [];

for (const provider of await loadProviders()) {
  validate(validators.provider, provider, `provider:${provider.id}`);
}

for (const subnet of await loadSubnets()) {
  validate(validators.subnet, subnet, `subnet:${subnet.slug}`);
}

for (const candidate of await loadCandidates()) {
  validate(validators.candidate, candidate, `candidate:${candidate.id}`);
}

validate(validators.artifacts, {
  api_index: await readJson(path.join(repoRoot, "public/metagraph/api-index.json")),
  candidates: await readJson(path.join(repoRoot, "public/metagraph/candidates.json")),
  changelog: await readJson(path.join(repoRoot, "public/metagraph/changelog.json")),
  contracts: await readJson(path.join(repoRoot, "public/metagraph/contracts.json")),
  coverage: await readJson(path.join(repoRoot, "public/metagraph/coverage.json")),
  curation: await readJson(path.join(repoRoot, "public/metagraph/curation.json")),
  endpoint_pools: await readJson(path.join(repoRoot, "public/metagraph/rpc/pools.json")),
  evidence_ledger: await readJson(path.join(repoRoot, "public/metagraph/evidence-ledger.json")),
  freshness: await readJson(path.join(repoRoot, "public/metagraph/freshness.json")),
  gaps: await readJson(path.join(repoRoot, "public/metagraph/gaps.json")),
  health: await readJson(path.join(repoRoot, "public/metagraph/health/latest.json")),
  providers: await readJson(path.join(repoRoot, "public/metagraph/providers.json")),
  r2_manifest: await readJson(path.join(repoRoot, "public/metagraph/r2-manifest.json")),
  review: await readJson(path.join(repoRoot, "public/metagraph/review/curation.json")),
  rpc_endpoints: await readJson(path.join(repoRoot, "public/metagraph/rpc-endpoints.json")),
  schema_drift: await readJson(path.join(repoRoot, "public/metagraph/schema-drift.json")),
  search: await readJson(path.join(repoRoot, "public/metagraph/search.json")),
  source_health: await readJson(path.join(repoRoot, "public/metagraph/source-health.json")),
  source_snapshots: await readJson(path.join(repoRoot, "public/metagraph/source-snapshots.json")),
  subnets: await readJson(path.join(repoRoot, "public/metagraph/subnets.json")),
  surfaces: await readJson(path.join(repoRoot, "public/metagraph/surfaces.json")),
  verification: await readJson(path.join(repoRoot, "public/metagraph/verification/latest.json"))
}, "public-artifacts");

if (errors.length > 0) {
  console.error(`Schema validation failed with ${errors.length} issue(s):`);
  for (const error of errors.slice(0, 80)) {
    console.error(`- ${error}`);
  }
  if (errors.length > 80) {
    console.error(`- ... ${errors.length - 80} more`);
  }
  process.exit(1);
}

console.log("JSON Schema validation passed.");

function validate(validator, value, label) {
  if (!validator(value)) {
    for (const error of validator.errors || []) {
      errors.push(`${label}${error.instancePath}: ${error.message}`);
    }
  }
}
