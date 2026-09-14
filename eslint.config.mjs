// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from "@iobroker/eslint-config";

export default [
	...config,
	{
		// specify files to exclude from linting here
		ignores: [
			".dev-server/",
			".vscode/",
			"*.test.js",
			"test/**/*.js",
			"*.config.mjs",
			"build",
			"dist",
			// generated build of the web app (contains the minified bundle)
			"www",
			"admin/words.js",
			"admin/admin.d.ts",
			"admin/blockly.js",
			"**/adapter-config.d.ts",
			"widgets/**/*.js",
		],
	},
	{
		// test helpers and test data do not need full JSDoc; production code stays documented
		files: ["**/*.test.ts"],
		rules: {
			"jsdoc/require-jsdoc": "off",
			"jsdoc/require-param-description": "off",
			"jsdoc/require-returns-description": "off",
		},
	},
	{
		// the API types of the web app mirror the JSON of the adapter field by field (like a generated client);
		// the interfaces themselves are documented, the single fields are named after the API
		files: ["src-pwa/src/api/types.ts"],
		rules: {
			"jsdoc/require-jsdoc": "off",
		},
	},
	{
		// you may disable some 'jsdoc' warnings - but using jsdoc is highly recommended
		// as this improves maintainability. jsdoc warnings will not block build process.
		rules: {
			// 'jsdoc/require-jsdoc': 'off',
			// 'jsdoc/require-param': 'off',
			// 'jsdoc/require-param-description': 'off',
			// 'jsdoc/require-returns-description': 'off',
			// 'jsdoc/require-returns-check': 'off',
		},
	},
];
