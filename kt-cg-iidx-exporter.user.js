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
// ==/UserScript==

(() => {
  "use strict";

  // -----------------------------------------
  const PAGE_LIMIT = 10; // do not abuse this!
  // -----------------------------------------

  const SLEEP_TIME_BETWEEN_PAGES = 250;
  const API_KEY = "api-key";
  const KAMAI_COLOR = "#e61c6e";
  const CLIENT_FILE_FLOW =
    "https://kamai.tachi.ac/client-file-flow/CIb4851b4fd80234cacb9934c1c0eee1c9d9da3030";
  const LOG_SEPARATOR = "-".repeat(40);

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
   * Send a message to the log box.
   *
   * @param {string} txt
   */
  function log(txt) {
    const statusNode = document.getElementById("log-box");
    const FORMAT = "hh:mm:ss";
    const dateText = dateFns.format(new Date(), FORMAT);
    statusNode.innerHTML += `[${dateText}] ${txt}\n`;

    // autoscroll to the newest message
    try {
      statusNode.scrollTop = statusNode.scrollHeight;
    } catch (e) {
      // ignore if element not available or not scrollable
    }
  }

  /**
   * Create a log box under this script's buttons.
   */
  function createLogBox() {
    // inject custom scrollbar styles once
    if (!document.getElementById("ktimporter-scroll-style")) {
      const style = document.createElement("style");
      style.id = "ktimporter-scroll-style";
      style.textContent = `
        /* WebKit-based browsers */
        #log-box::-webkit-scrollbar { width: 10px; height: 10px; }
        #log-box::-webkit-scrollbar-track { background: transparent; }
        #log-box::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 6px; }
        #log-box::-webkit-scrollbar-button { display: none; height: 0; }

        /* Firefox */
        #log-box { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.12) transparent; }
      `;
      document.head.appendChild(style);
    }
    // create a table cell and put a scrollable div inside it so the page
    // doesn't grow indefinitely when many log messages are produced
    const td = document.createElement("td");
    td.setAttribute("colspan", 2);

    const inner = document.createElement("div");
    inner.id = "log-box";
    Object.assign(inner.style, {
      whiteSpace: "pre",
      height: "200px",
      overflow: "auto",
      padding: "0.25rem",
      background: "transparent",
    });

    td.appendChild(inner);

    const importStatusRow = document.createElement("tr");
    importStatusRow.append(td);

    const panelFooterRow = document.querySelector("form .panel tfoot tr");
    panelFooterRow.after(importStatusRow);
  }

  /**
   * Get a value from local storage.
   *
   * @param {string} key
   * @returns
   */
  function getPreference(key) {
    return localStorage.getItem(`__ktimporter__${key}`);
  }

  /**
   * Set a key-value pair in local storage.
   *
   * @param {string} key
   * @param {string} value
   * @returns
   */
  function setPreference(key, value) {
    return localStorage.setItem(`__ktimporter__${key}`, value.toString());
  }

  /**
   * Verify a Kamaitachi API key. Return `true` if valid, `false` otherwise.
   *
   * @param {string} apiKey
   * @returns {boolean}
   */
  async function verifyApiKey(apiKey) {
    const resp = await fetch(`https://kamai.tachi.ac/api/v1/users/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }).then((r) => r.json());

    if (!resp.success) {
      return false;
    }

    return true;
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

    const start = pageQueue.at(0);
    const end = pageQueue.at(-1);

    log(`Fetching all scores from pages ${start} to ${end}...`);

    for (let i = start; i <= end; i++) {
      const url = document.URL.split("?")[0] + `?page=${i}`;
      const resp = await fetch(url);
      const doc = parser.parseFromString(await resp.text(), "text/html");

      const pageScores = fetchScores(doc);
      scores.SP = scores.SP.concat(pageScores.SP);
      scores.DP = scores.DP.concat(pageScores.DP);
      log(`Fetched all scores from ${url}`);

      await sleep(SLEEP_TIME_BETWEEN_PAGES);
    }

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
   * Poll the status of a Kamaitachi import.
   *
   * @param {string} url
   * @param {string} gameVer
   * @param {string} playtype
   */
  async function pollStatus(url, gameVer, playtype) {
    const req = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${getPreference(API_KEY)}`,
      },
    });

    const body = await req.json();

    if (!body.success) {
      updateStatus("Error: " + body.description);
      return;
    }

    if (body.body.importStatus === "ongoing") {
      setTimeout(pollStatus, 1000, url, gameVer, playtype);
      return;
    }

    if (body.body.importStatus === "completed") {
      console.log(body.body);
      let message =
        `[Import for IIDX ${gameVer} ${playtype}] ` +
        body.description +
        ` ${body.body.import.scoreIDs.length} new scores`;

      let errorNote = "";

      if (body.body.import.errors.length > 0) {
        errorNote = " (see console log for details)";
        for (const error of body.body.import.errors) {
          console.log(`${error.type}: ${error.message}`);
        }
      }

      message += `, ${body.body.import.errors.length} errors${errorNote}.`;
      log(message);

      return;
    }

    // otherwise, just print the description cuz we're not sure what happened
    log(body.description);
  }

  /**
   * Submit scores to Kamaitachi via DIRECT-MANUAL.
   *
   * @param {object} body
   * @param {string} gameVer
   * @param {string} playtype
   */
  async function submitScores(body, gameVer, playtype) {
    const url = "https://kamai.tachi.ac/ir/direct-manual/import";

    const req = fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + getPreference(API_KEY),
        "Content-Type": "application/json",
        "X-User-Intent": "true",
      },
      body: JSON.stringify(body),
    });

    const json = await (await req).json();
    // if json.success
    const pollUrl = json.body.url;

    await pollStatus(pollUrl, gameVer, playtype);
  }

  /**
   * Count how many different imports are needed for all the fetched scores.
   *
   * @param { Record<string, {SP: object[]; DP: object[]}> } scoresByGameVer
   * @returns {number}
   */
  function countNumImports(scoresByGameVer) {
    let res = 0;

    for (const gameVer in scoresByGameVer) {
      const scores = scoresByGameVer[gameVer];

      if (scores.SP.length > 0) {
        res++;
      }

      if (scores.DP.length > 0) {
        res++;
      }
    }

    return res;
  }

  /**
   * Main function for the import button.
   */
  async function importScores() {
    log(LOG_SEPARATOR);

    const scoresUngrouped = await fetchScoresForPages();
    const scoresByGameVer = groupScoresByGameVer(scoresUngrouped);

    const numImports = countNumImports(scoresByGameVer);
    log(
      `Starting imports for each game version and playtype (${numImports} import(s))...`
    );
    log(LOG_SEPARATOR);

    // TODO: this for-loop might be a janky way of doing it since we're
    // dealing with async/await. if we happen to see significant
    // performance issues then we'll reconsider.

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

      // we're not gonna bother sleeping in between API calls
      // cause surely there won't be a user that has a million game versions
      if (scores.SP.length > 0) {
        await submitScores(batchJson, gameVer, "SP");
      }
      if (scores.DP.length > 0) {
        batchJson.meta.playtype = "DP";
        batchJson.scores = scores.DP;

        await submitScores(batchJson, gameVer, "DP");
      }
    }
  }

  /**
   * Show a full-page dark overlay with a centered modal to enter API key.
   * Saves the key via `setPreference(API_KEY, value)` and enables the import button.
   *
   * **NOTE: This function is vibe-coded :)**
   *
   * @param {string} currentValue
   */
  function showApiKeyModal(currentValue) {
    // overlay
    const overlay = document.createElement("div");
    overlay.id = "ktimporter-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      backgroundColor: "rgba(0,0,0,0.5)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 9999,
    });

    // modal
    const modal = document.createElement("div");
    Object.assign(modal.style, {
      background: "#1e1e1e",
      color: "#eee",
      padding: "1rem",
      borderRadius: "6px",
      minWidth: "320px",
      maxWidth: "90%",
      boxShadow: "0 6px 24px rgba(0,0,0,0.6)",
    });

    const title = document.createElement("div");
    title.textContent = "Enter API key";
    title.style.fontWeight = "600";
    title.style.marginBottom = "0.5rem";

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentValue || "";
    input.placeholder = "API key";
    Object.assign(input.style, {
      width: "100%",
      padding: "0.5rem",
      marginBottom: "0.75rem",
      boxSizing: "border-box",
      background: "#222",
      color: "#fff",
      border: "1px solid #333",
      borderRadius: "4px",
      outline: "none",
    });

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "0.5rem",
    });

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.marginRight = "0.5rem";
    Object.assign(cancel.style, {
      background: "transparent",
      color: "#ddd",
      border: "1px solid rgba(255,255,255,0.06)",
      padding: "0.4rem 0.6rem",
      borderRadius: "4px",
      cursor: "pointer",
    });

    const getKeyBtn = document.createElement("button");
    getKeyBtn.type = "button";
    getKeyBtn.textContent = "Get API key";
    getKeyBtn.style.marginRight = "0.5rem";
    Object.assign(getKeyBtn.style, {
      background: "transparent",
      color: "#ddd",
      border: "1px solid rgba(255,255,255,0.06)",
      padding: "0.4rem 0.6rem",
      borderRadius: "4px",
      cursor: "pointer",
    });

    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = "OK";
    Object.assign(ok.style, {
      background: KAMAI_COLOR,
      color: "#fff",
      border: "none",
      padding: "0.45rem 0.8rem",
      borderRadius: "4px",
      cursor: "pointer",
    });

    // left group (gets left-aligned)
    const leftGroup = document.createElement("div");
    leftGroup.appendChild(getKeyBtn);

    // right group (keeps Cancel/OK on the right)
    const rightGroup = document.createElement("div");
    rightGroup.appendChild(cancel);
    rightGroup.appendChild(ok);

    btnRow.appendChild(leftGroup);
    btnRow.appendChild(rightGroup);

    modal.appendChild(title);
    modal.appendChild(input);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // focus the input
    setTimeout(() => input.focus(), 10);

    // disable page scrolling while modal is open; save previous values to restore later
    const _prevBodyOverflow = document.body.style.overflow || "";
    const _prevHtmlOverflow = document.documentElement.style.overflow || "";
    const _prevBodyPaddingRight = document.body.style.paddingRight || "";
    const _scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    if (_scrollbarWidth > 0) {
      document.body.style.paddingRight = `${_scrollbarWidth}px`;
    }
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    // track whether a mousedown started inside the modal so releasing
    // the mouse outside (e.g. when selecting text) doesn't close the overlay.
    let mouseDownStartedInModal = false;
    function onDocumentMouseDown(e) {
      mouseDownStartedInModal = modal.contains(e.target);
    }
    document.addEventListener("mousedown", onDocumentMouseDown, true);

    function closeOverlay() {
      // restore scrolling styles
      document.body.style.overflow = _prevBodyOverflow;
      document.documentElement.style.overflow = _prevHtmlOverflow;
      document.body.style.paddingRight = _prevBodyPaddingRight;

      if (overlay && overlay.parentNode)
        overlay.parentNode.removeChild(overlay);
      // cleanup document-level listener
      document.removeEventListener("mousedown", onDocumentMouseDown, true);
    }

    cancel.addEventListener("click", () => {
      closeOverlay();
    });

    getKeyBtn.addEventListener("click", () => {
      window.open(CLIENT_FILE_FLOW, "_blank", "noopener");
    });

    overlay.addEventListener("click", (ev) => {
      if (ev.target !== overlay) return;
      // If the user started the mousedown inside the modal (for selection)
      // and released outside, ignore this click so the modal stays open.
      if (mouseDownStartedInModal) {
        mouseDownStartedInModal = false;
        return;
      }
      closeOverlay();
    });

    ok.addEventListener("click", async () => {
      const val = input.value.trim();
      if (!val) {
        // minimal validation
        input.focus();
        return;
      }

      // close the modal immediately so the user can see log messages
      closeOverlay();

      log("Verifying API key...");

      const isValid = await verifyApiKey(val);
      if (!isValid) {
        log("Error: Failed to verify API key.");
        return;
      }

      setPreference(API_KEY, val);
      log("API key verified and saved. Reloading page to apply changes...");
      setTimeout(() => location.reload(), 150);
    });

    // allow Enter key in the input to activate the OK button
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        ok.click();
      }
    });
  }

  /**
   * Create an API key button next to the Update button.
   */
  function createApiKeyButton() {
    const panelFooterRow = document.querySelector("form .panel tfoot tr");
    const updateButton = panelFooterRow.querySelector('input[value="Update"]');
    const apiKeyButton = updateButton.cloneNode();

    apiKeyButton.setAttribute("type", "button");
    apiKeyButton.id = "api-key-button";
    apiKeyButton.style.backgroundColor = KAMAI_COLOR;
    apiKeyButton.style.margin = "0 0.75em";

    // the button's text depends on whether an API key is set or not
    const hasApiKey = !!getPreference(API_KEY);
    apiKeyButton.value = hasApiKey
      ? "Reconfigure API key (if broken)"
      : "Set API key";

    updateButton.after(apiKeyButton);

    apiKeyButton.onclick = () => {
      const current = getPreference(API_KEY) || "";
      showApiKeyModal(current);
    };
  }

  /**
   * Create an import button next to the API key button.
   */
  function createImportButton() {
    const apiKeyButton = document.getElementById("api-key-button");

    if (!apiKeyButton) {
      console.error(
        "Error: createImportButton() was called before the API key button was created"
      );
      return;
    }

    const importButton = apiKeyButton.cloneNode();
    importButton.style.margin = "0";

    importButton.setAttribute("type", "button");
    importButton.id = "import-button";

    const pageQueue = getPageQueue();
    importButton.value = `Import pages ${pageQueue.at(0)}-${pageQueue.at(-1)}`;

    apiKeyButton.after(importButton);

    importButton.onclick = async () => {
      await importScores();
    };

    // disable the button if API key is not set
    const hasApiKey = !!getPreference(API_KEY);
    if (!hasApiKey) {
      importButton.disabled = true;
    }
  }

  createLogBox();
  log("Userscript ready! Logs will appear here.");

  createApiKeyButton();
  createImportButton();
})();
