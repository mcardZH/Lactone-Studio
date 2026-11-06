"use strict";
const { createSoftwareAdapter } = require("./adapters.cjs");
module.exports = {
	createSoftwareAdapter,
	gaussian: () => createSoftwareAdapter("gaussian"),
	orca: () => createSoftwareAdapter("orca")
};
