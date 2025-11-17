// ==UserScript==
// @name     kt-cg-iidx-importer
// @author   tranq
// @version  1.0.0
// @grant    none

// @match    https://dev.cardinal-gate.net/iidx/profile*
// @match    https://cgate.dev/iidx/profile*
// @match    https://www.cgate.dev/iidx/profile*
// @match    https://ganymede-cg.net/iidx/profile*
// @match    https://www.ganymede-cg.net/iidx/profile*
// @match    https://nageki-cg.net/iidx/profile*
// @match    https://www.nageki-cg.net/iidx/profile*

// @require  https://cdn.jsdelivr.net/npm/date-fns@3.6.0/cdn.min.js
// @require  https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js
// ==/UserScript==

(() => {
  "use strict";

  // do not abuse these!
  const SLEEP_TIME_BETWEEN_PAGES = 250;
  const PAGE_LIMIT = 10;

  const difficultyMap = {
    B: "BEGINNER",
    N: "NORMAL",
    H: "HYPER",
    A: "ANOTHER",
    L: "LEGGENDARIA",
  };

  /**
   * Determine the BATCH-MANUAL service name based on the current CG instance.
   *
   * @returns {string}
   */
  function getServiceName() {
    let base = "kt-cg-iidx-importer";
    const url = window.location.href;

    if (url.includes("dev")) {
      base += " (Dev)";
    } else if (url.includes("ganymede")) {
      base += " (GAN)";
    } else if (url.includes("nageki")) {
      base += " (NAG)";
    }

    return base;
  }

  /**
   * Send a message to the log under the export button.
   *
   * @param {string} txt
   */
  function log(txt) {
    const statusNode = document.getElementById("export-status");
    const FORMAT = "hh:mm:ss.u";
    const dateText = dateFns.format(new Date(), FORMAT);
    statusNode.innerHTML += `[${dateText}] ${txt}\n`;
  }

  /**
   * Wait for `ms` milliseconds.
   *
   * @param {number} ms
   * @returns {Promise<any>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Return an object containing the current page number and the total number
   * of pages.
   *
   * @returns { {currentPage: number; totalPages: number;} }
   */
  function getPageInfo() {
    const pageTextNode =
      document.querySelector(".score-grid").nextElementSibling;

    const result = {
      currentPage: 1,
      totalPages: 1,
    };

    if (pageTextNode) {
      result.currentPage = parseInt(pageTextNode.innerText.split(" ")[1]);
      result.totalPages = parseInt(pageTextNode.innerText.split(" ")[3]);
    }
    return result;
  }

  /**
   * Return an array containing the pages to be queried.
   * The first page is always the current page.
   *
   * @returns {number[]}
   */
  function getPageQueue() {
    const pageInfo = getPageInfo();
    const result = [];

    for (let i = pageInfo.currentPage; i <= pageInfo.totalPages; i++) {
      if (result.length == PAGE_LIMIT) {
        break;
      }
      result.push(i);
    }

    return result;
  }

  /**
   * Convert a CG timestamp to unix milliseconds.
   *
   * @param {string} date
   * @returns {number}
   */
  function parseDate(date) {
    date = date.replace("UTC", "+0000");
    if (date.match(/\w{3} \d{4}/g)) {
      return dateFns.parse(date, "do MMM y, H:mm xx", new Date()).getTime();
    }
    return dateFns.parse(date, "do MMM, H:mm xx", new Date()).getTime();
  }

  /**
   * Given the DOM of a page of scores, parse the scores into objects.
   *
   * WARNING: In order to handle scores across different game versions,
   * a custom property is added to each score object to allow for grouping.
   * This property should be removed by the time the final JSON gets built.
   *
   * @param {Document} doc
   * @returns { {SP: object[]; DP: object[]} }
   */
  function fetchScores(doc) {
    const scores = {
      SP: [],
      DP: [],
    };

    const scoreDivs = doc
      .querySelector(".score-grid")
      .querySelectorAll(":scope > .grid-x");

    scoreDivs.forEach((div) => {
      const cells = div.querySelectorAll(":scope > .cell");

      const scoreObj = {
        // custom property
        gameVerButThisShouldNotBeInTheFinalJson: cells[0]
          .querySelector("a")
          .href.split("/")[5],

        matchType: "inGameID",
      };

      const difficulty =
        difficultyMap[
          cells[0].querySelectorAll("strong")[1].textContent.trim().slice(-1)
        ];

      // kt doesn't track beginner charts, so just ignore the score
      if (difficulty == "BEGINNER") {
        return;
      }

      scoreObj.identifier = cells[0].querySelector("a").href.split("/")[6];
      scoreObj.difficulty = difficulty;
      scoreObj.lamp = cells[0].querySelector(".label").textContent.trim();
      scoreObj.score = +cells[2]
        .querySelector("strong")
        .textContent.trim()
        .split(" ")[0]
        .replace(",", "");
      scoreObj.timeAchieved = parseDate(
        cells[2].querySelectorAll(".cell")[1].textContent.trim()
      );
      scoreObj.judgements = {
        pgreat: +cells[2]
          .querySelector("strong")
          .title.split(",")[0]
          .trim()
          .split(" ")[0],
        great: +cells[2]
          .querySelector("strong")
          .title.split(",")[1]
          .trim()
          .split(" ")[0],
      };

      // cg displays unknown BP as "- MC"
      const potentialBP = cells[2]
        .querySelector("strong")
        .title.split(",")[2]
        .trim()
        .split(" ")[0];
      if (potentialBP != "-") {
        scoreObj.optional = { bp: +potentialBP };
      }

      const playtype = cells[0]
        .querySelectorAll("strong")[1]
        .textContent.trim()
        .slice(0, 2);
      if (playtype == "SP") {
        scores.SP.push(scoreObj);
      } else {
        scores.DP.push(scoreObj);
      }
    });

    return scores;
  }

  /**
   * Iterate over a set of pages and parse their scores.
   *
   * @returns { Promise<{SP: object[]; DP: object[]}> }
   */
  async function fetchScoresForPages() {
    const pageQueue = getPageQueue();
    const parser = new DOMParser();
    const scores = {
      SP: [],
      DP: [],
    };

    for (let i = pageQueue.at(0); i <= pageQueue.at(-1); i++) {
      const url = document.URL.split("?")[0] + `?page=${i}`;
      log(`Fetching scores from ${url}`);
      const resp = await fetch(url);
      const doc = parser.parseFromString(await resp.text(), "text/html");
      const pageScores = fetchScores(doc);
      log(`    Fetched ${pageScores.SP.length} SP scores.`);
      log(`    Fetched ${pageScores.DP.length} DP scores.`);
      scores.SP = scores.SP.concat(pageScores.SP);
      scores.DP = scores.DP.concat(pageScores.DP);
      log(
        `Waiting ${SLEEP_TIME_BETWEEN_PAGES}ms to avoid overloading the website...`
      );
      await sleep(SLEEP_TIME_BETWEEN_PAGES);
    }

    log(
      `Fetched all scores from pages ${pageQueue.at(0)} to ${pageQueue.at(-1)}.`
    );
    return scores;
  }

  /**
   * Group score objects by their game versions and
   * remove the custom property used.
   *
   * @param { {SP: object[]; DP: object[]} } scores
   * @returns { Record<string, {SP: object[]; DP: object[]}> }
   */
  function groupScoresByGameVer(scores) {
    const res = {};

    for (const playtype of Object.keys(scores)) {
      for (const score of scores[playtype]) {
        const { gameVerButThisShouldNotBeInTheFinalJson, ...rest } = score;
        const gameVer = gameVerButThisShouldNotBeInTheFinalJson;

        if (!res[gameVer]) {
          res[gameVer] = { SP: [], DP: [] };
        }

        res[gameVer][playtype].push(rest);
      }
    }

    return res;
  }

  /**
   * Download all parsed scores to a JSON in BATCH-MANUAL format.
   */
  async function downloadScores() {
    log(
      "Starting script. Make sure to allow multiple downloads if you play on more than one game version and/or playtype (SP/DP)."
    );

    const nowText = dateFns.format(new Date(), "yyyy-MM-dd-'at'-hh-mm-ss");
    const scoresUngrouped = await fetchScoresForPages();
    const scoresByGameVer = groupScoresByGameVer(scoresUngrouped);

    log(`Total SP: ${scoresUngrouped.SP.length}`);
    log(`Total DP: ${scoresUngrouped.DP.length}`);

    // go by each game version and then by each playtype
    for (const gameVer in scoresByGameVer) {
      const scores = scoresByGameVer[gameVer];

      const batchJson = {
        meta: {
          game: "iidx",
          playtype: "SP",
          service: getServiceName(),
          version: gameVer,
        },
        scores: scores.SP,
      };

      let blob;
      const blobType = "application/json;charset=utf-8";
      if (scores.SP.length > 0) {
        log(`Generating IIDX ${gameVer} SP file...`);
        blob = new Blob([JSON.stringify(batchJson, null, 2)], {
          type: blobType,
        });
        saveAs(blob, `export-cg-iidx${gameVer}-sp-${nowText}.json`);
      }
      if (scores.DP.length > 0) {
        batchJson.meta.playtype = "DP";
        batchJson.scores = scores.DP;

        log(`Generating IIDX ${gameVer} DP file...`);
        blob = new Blob([JSON.stringify(batchJson, null, 2)], {
          type: blobType,
        });
        saveAs(blob, `export-cg-iidx${gameVer}-dp-${nowText}.json`);
      }
    }

    log("Done!");
    const kamaiLink =
      `<a href="https://kamai.tachi.ac/import/batch-manual" target="_blank">` +
      `https://kamai.tachi.ac/import/batch-manual` +
      `</a>`;
    log(`File(s) should be ready to be uploaded to ${kamaiLink}.`);
  }

  /**
   * Create an export button next to the Update button.
   */
  function createExportButton() {
    const kamaiColor = "#e61c6e";
    const panelFooterRow = document.querySelector("form .panel tfoot tr");
    const updateButton = panelFooterRow.querySelector('input[value="Update"]');
    const exportButton = updateButton.cloneNode();

    exportButton.setAttribute("type", "button");
    exportButton.setAttribute("name", "export");
    const pageQueue = getPageQueue();
    exportButton.value = `Export pages ${pageQueue.at(0)}-${pageQueue.at(-1)}`;
    exportButton.style.backgroundColor = kamaiColor;
    exportButton.style.margin = "0 1em";

    updateButton.after(exportButton);

    const exportStatus = document.createElement("td");
    exportStatus.id = "export-status";
    exportStatus.setAttribute("colspan", 2);
    exportStatus.style.whiteSpace = "pre";
    const exportStatusRow = document.createElement("tr");
    panelFooterRow.after(exportStatusRow);
    exportStatusRow.append(exportStatus);

    exportButton.onclick = async () => {
      await downloadScores();
    };
  }

  createExportButton();
})();
