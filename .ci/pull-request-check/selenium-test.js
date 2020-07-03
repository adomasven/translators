#!/usr/bin/env node

const path = require('path');
const process = require('process');
const { exec } = require('child_process');
const fs = require('fs').promises;
const selenium = require('selenium-webdriver');
const until = require('selenium-webdriver/lib/until');
const chalk = require('chalk');

const translatorServer = require('./translator-server');

const chromeExtensionDir = path.join(__dirname, 'connectors', 'build', 'chrome');
const KEEP_BROWSER_OPEN = 'KEEP_BROWSER_OPEN' in process.env;

async function getTranslatorsToTest() {
	const translatorFilenames = await new Promise((resolve) => {
		exec('git diff master --name-only | grep -e "^[^/]*\.js$"', (err, stdout) => {
			if (err) {
				console.log(chalk.red("Failed to get the list of translators to test"));
				process.exit(1)
			}
			resolve(stdout.split('\n').filter(str => str.length));
		})
	});
	let translatorIDs = [];
	for (const translatorFilename of translatorFilenames) {
		let translatorInfo = translatorServer.filenameToTranslator[translatorFilename].metadata;
		translatorIDs.push(translatorInfo.translatorID);
	}
	return translatorIDs;
}

function report(results) {
	var allPassed = true;
	for (let translatorID in results) {
		let translatorResults = results[translatorID];
		console.log(chalk.bold(chalk.inverse(`Beginning Tests for ${translatorID}: ${translatorResults.label}`)));
		let padding = 2;
		let output = translatorResults.message.split("\n");
		for (let line of output) {
			if (line.match(/^TranslatorTester: Running [^T]*Test [0-9]*$/) ||
				line.match(/^TranslatorTester: Running [0-9]* tests for .*$/)) {
				console.log("  ".repeat(padding-1) + chalk.inverse(chalk.cyan(line)));
			}
			else if (line.match(/^-/)) {
				console.log(chalk.red("-" + "  ".repeat(padding) + line.substr(1)));
			}
			else if (line.match(/^\+/)) {
				console.log(chalk.green("+" + "  ".repeat(padding) + line.substr(1)));
			}
			else if (line.match(/^TranslatorTester: [^T]*Test [0-9]*: succeeded/)) {
				console.log("  ".repeat(padding) + chalk.bgGreen(line));
			}
			else if (line.match(/^TranslatorTester: [^T]*Test [0-9]*: unknown/)) {
				console.log("  ".repeat(padding) + chalk.bgYellow(line));
				allPassed = false;
			}
			else if (line.match(/^TranslatorTester: [^T]*Test [0-9]*: failed/)) {
				console.log("  ".repeat(padding) + chalk.bgRed(line));
				allPassed = false;
			}
			else {
				console.log("  ".repeat(padding) + line);
			}
		}
		console.log("\n");
	}

	return allPassed
}

var results = {};
results.promise = new Promise(function(resolve, reject) {
	results.resolve = resolve;
	results.reject = reject;
});
let testResults;

(async function() {
	let driver;
	try {
		translatorServer.serve();
		require('chromedriver');
		let chrome = require('selenium-webdriver/chrome');
		let options = new chrome.Options();
		options.addArguments(`load-extension=${chromeExtensionDir}`);
		if ('BROWSER_EXECUTABLE' in process.env) {
			options.setChromeBinaryPath(process.env['BROWSER_EXECUTABLE']);
		}

		driver = new selenium.Builder()
			.forBrowser('chrome')
			.setChromeOptions(options)
			.build();

		// No API to retrieve extension ID. Hacks, sigh.
		await driver.get("chrome://system/");
		await driver.wait(until.elementLocated({id: 'extensions-value-btn'}), 60*1000);
		let extBtn = await driver.findElement({css: '#extensions-value-btn'});
		await extBtn.click();
		let contentElem = await driver.findElement({css: '#content'});
		let text = await contentElem.getText();
		let extId = text.match(/([^\s]*) : Zotero Connector/)[1];

		// We got the extension ID and test URL, let's test
		const translatorsToTest = await getTranslatorsToTest();
		let testUrl = `chrome-extension://${extId}/tools/testTranslators/testTranslators.html#translators=${translatorsToTest.join(',')}`;
		await new Promise((resolve) => setTimeout(() => resolve(driver.get(testUrl)), 500));
		await driver.wait(until.elementLocated({id: 'translator-tests-complete'}), 10*60*1000);
		testResults = await driver.executeScript('return window.seleniumOutput');
	}
	catch (e) {
		results.reject(e);
	}
	finally {
		translatorServer.stopServing();

		if (KEEP_BROWSER_OPEN) {
			return results.resolve(testResults);
		}
		return driver.quit().then(() => results.resolve(testResults));
	}
})();

results.promise.then(function(results) {
	var allPassed = report(results);

	if (!allPassed) {
		process.exit(1)
	}
}, console.error);
