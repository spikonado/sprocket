const SCHEMA_EXPORT = 'export default defineSchema(';
const STAGING_MARKER = '// Artifact archive staging schema';

export function stageArtifactSchema(source) {
	if (source.includes(STAGING_MARKER) || source.split(SCHEMA_EXPORT).length !== 2) {
		throw new Error('Expected one final schema export; refusing to stage an unknown schema.');
	}
	if (!source.includes('oldArtifacts:') || source.includes('artifactVersions:')) {
		throw new Error('The final schema must declare oldArtifacts and remove artifactVersions.');
	}
	return `import { stagingArtifactsTable, artifactVersionsTable } from '@convex/lib/artifactArchive';
${source.replace(SCHEMA_EXPORT, 'const finalSchema = defineSchema(')}
${STAGING_MARKER}
export default defineSchema({
	...finalSchema.tables,
	artifacts: stagingArtifactsTable,
	artifactVersions: artifactVersionsTable
});
`;
}
