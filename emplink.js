(function () {
  "use strict";

  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.warn("[emplink] PluginApi not available");
    return;
  }

  const React = PluginApi.React;
  const { Form } = PluginApi.libraries.Bootstrap;

  const PLUGIN_ID = "emplink";
  const EMP_FAVICON = "/plugin/emplink/assets/favicon.ico";
  const BUNKR_FAVICON = "/plugin/emplink/assets/bunkr-favicon.ico";
  const MAX_ATTEMPTS = 40;
  const RETRY_MS = 250;

  const DEFAULT_EMP_BASE_URL = "https://www.empornium.sx";
  const DEFAULT_BUNKR_BASE_URL = "https://balbums.st";
  const SEARCH_MENU_CLASS =
    "dropdown-menu dropdown-menu-end bg-secondary text-white emplink-search-menu";

  let injectTimer = null;
  let pageObserver = null;
  let pluginConfig = migratePluginSettings({});
  let cachedPerformerId = null;
  let cachedSearchTerms = null;

  function parseBoolean(value, defaultValue) {
    if (value === true || value === "true") {
      return true;
    }
    if (value === false || value === "false") {
      return false;
    }
    return defaultValue;
  }

  function normalizeBaseUrl(url) {
    let value = String(url ?? "").trim();
    if (!value) {
      return "";
    }
    if (!/^https?:\/\//i.test(value)) {
      value = "https://" + value;
    }
    return value.replace(/\/+$/, "");
  }

  function migratePluginSettings(raw) {
    const settings = { ...(raw ?? {}) };
    settings.showEmpLink = parseBoolean(settings.showEmpLink, true);
    settings.showBunkrLink = parseBoolean(settings.showBunkrLink, true);
    settings.empBaseUrl = normalizeBaseUrl(
      settings.empBaseUrl || DEFAULT_EMP_BASE_URL
    );
    settings.bunkrBaseUrl = normalizeBaseUrl(
      settings.bunkrBaseUrl || DEFAULT_BUNKR_BASE_URL
    );
    return settings;
  }

  function applyPluginSettings(settings) {
    pluginConfig = migratePluginSettings(settings);
  }

  function clearPerformerCache() {
    cachedPerformerId = null;
    cachedSearchTerms = null;
  }

  async function loadSettings() {
    try {
      const client = PluginApi.utils.StashService.getClient();
      const { data } = await client.query({
        query: PluginApi.GQL.ConfigurationDocument,
        fetchPolicy: "network-only",
      });
      applyPluginSettings(data?.configuration?.plugins?.[PLUGIN_ID]);
    } catch (error) {
      console.warn("[emplink] Failed to load plugin settings:", error);
    }
  }

  function buildEmpUrl(performerName) {
    const ename = performerName.replace(/ /g, ".");
    const base = pluginConfig.empBaseUrl || DEFAULT_EMP_BASE_URL;
    return (
      base +
      "/torrents.php" +
      "?order_by=snatched" +
      "&order_way=desc" +
      "&filter_freeleech=1" +
      "&taglist=" +
      encodeURIComponent(ename)
    );
  }

  function buildBunkrUrl(performerName) {
    const search = performerName
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("+");
    const base = pluginConfig.bunkrBaseUrl || DEFAULT_BUNKR_BASE_URL;
    return base + "/?search=" + search + "&mode=broad&per=20&sort=latest";
  }

  function getPerformerIdFromPath(pathname) {
    const path = pathname ?? window.location.pathname;
    const match = path.match(/^\/performers\/(\d+)/);
    return match ? match[1] : null;
  }

  function getPerformerName() {
    const nameEl = document.querySelector("#performer-page span.performer-name");
    if (!nameEl) {
      return null;
    }
    return nameEl.textContent.trim() || null;
  }

  function collectSearchTerms(performer) {
    const terms = [];
    const seen = new Set();

    function add(term, label) {
      const trimmed = String(term ?? "").trim();
      if (!trimmed) {
        return;
      }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      terms.push({ term: trimmed, label: label || trimmed });
    }

    add(performer.name, performer.name);

    const aliases = performer.alias_list || [];
    for (let i = 0; i < aliases.length; i += 1) {
      add(aliases[i], aliases[i] + " (alias)");
    }

    if (performer.disambiguation) {
      add(
        performer.disambiguation,
        performer.disambiguation + " (disambiguation)"
      );
    }

    return terms;
  }

  async function fetchPerformerSearchTerms(performerId) {
    if (cachedPerformerId === performerId && cachedSearchTerms) {
      return cachedSearchTerms;
    }

    try {
      const client = PluginApi.utils.StashService.getClient();
      const document = PluginApi.GQL.FindPerformerDocument;
      if (!client || !document) {
        throw new Error("GraphQL not available");
      }

      const { data } = await client.query({
        query: document,
        variables: { id: performerId },
        fetchPolicy: "network-only",
      });

      const performer = data?.findPerformer;
      if (performer?.name) {
        cachedPerformerId = performerId;
        cachedSearchTerms = collectSearchTerms(performer);
        return cachedSearchTerms;
      }
    } catch (error) {
      console.warn("[emplink] Failed to fetch performer:", error);
    }

    const name = getPerformerName();
    const fallback = name ? [{ term: name, label: name }] : [];
    if (fallback.length) {
      cachedPerformerId = performerId;
      cachedSearchTerms = fallback;
    }
    return fallback;
  }

  function removePerformerLinks() {
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = null;
    }
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    document
      .querySelectorAll("#performer-page .name-icons [data-emplink-site]")
      .forEach(function (el) {
        el.remove();
      });
  }

  function createSiteIcon(iconSrc, iconClassName) {
    const img = document.createElement("img");
    img.src = iconSrc;
    img.alt = "";
    img.className = iconClassName;
    img.width = 16;
    img.height = 16;
    img.draggable = false;
    return img;
  }

  let dropdownCloseListenerAttached = false;

  function closeEmplinkDropdown(wrapper) {
    wrapper.classList.remove("show");
    const menu = wrapper.querySelector(".dropdown-menu");
    const toggle = wrapper.querySelector(".dropdown-toggle");
    if (menu) {
      menu.classList.remove("show");
    }
    if (toggle) {
      toggle.setAttribute("aria-expanded", "false");
    }
  }

  function closeAllEmplinkDropdowns() {
    document
      .querySelectorAll("#performer-page .emplink-site-dropdown.show")
      .forEach(closeEmplinkDropdown);
  }

  function openEmplinkDropdown(wrapper) {
    const menu = wrapper.querySelector(".dropdown-menu");
    const toggle = wrapper.querySelector(".dropdown-toggle");
    wrapper.classList.add("show");
    if (menu) {
      menu.classList.add("show");
    }
    if (toggle) {
      toggle.setAttribute("aria-expanded", "true");
    }
  }

  function ensureDropdownCloseListener() {
    if (dropdownCloseListenerAttached) {
      return;
    }
    dropdownCloseListenerAttached = true;
    document.addEventListener("click", function (event) {
      document
        .querySelectorAll("#performer-page .emplink-site-dropdown.show")
        .forEach(function (wrapper) {
          if (!wrapper.contains(event.target)) {
            closeEmplinkDropdown(wrapper);
          }
        });
    });
  }

  function bindEmplinkDropdown(wrapper) {
    if (wrapper.dataset.emplinkDropdownBound === "1") {
      return;
    }
    wrapper.dataset.emplinkDropdownBound = "1";

    const toggle = wrapper.querySelector(".dropdown-toggle");
    if (!toggle) {
      return;
    }

    ensureDropdownCloseListener();

    toggle.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = wrapper.classList.contains("show");
      closeAllEmplinkDropdowns();
      if (!isOpen) {
        openEmplinkDropdown(wrapper);
      }
    });
  }

  function createPerformerLink(options) {
    const link = document.createElement("a");
    link.className = "btn minimal " + options.className;
    link.href = options.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = options.title;
    link.dataset.emplinkSite = options.siteKey;
    link.appendChild(createSiteIcon(options.iconSrc, options.iconClassName));
    return link;
  }

  function applyDropdownTheme(wrapper) {
    wrapper.classList.add("show-carat");
    const menu = wrapper.querySelector(".dropdown-menu");
    if (menu) {
      menu.className = SEARCH_MENU_CLASS;
    }
  }

  function populateDropdownMenu(menu, terms, buildUrl) {
    menu.replaceChildren();
    for (let i = 0; i < terms.length; i += 1) {
      const entry = terms[i];
      const li = document.createElement("li");
      const item = document.createElement("a");
      item.className = "dropdown-item";
      item.href = buildUrl(entry.term);
      item.target = "_blank";
      item.rel = "noopener noreferrer";
      item.textContent = entry.label;
      li.appendChild(item);
      menu.appendChild(li);
    }
  }

  function createPerformerDropdown(options) {
    const wrapper = document.createElement("span");
    wrapper.className = "dropdown emplink-site-dropdown show-carat";
    wrapper.dataset.emplinkSite = options.siteKey;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn minimal dropdown-toggle " + options.className;
    toggle.setAttribute("aria-expanded", "false");
    toggle.title = options.title;
    toggle.appendChild(
      createSiteIcon(options.iconSrc, options.iconClassName)
    );

    const menu = document.createElement("ul");
    menu.className = SEARCH_MENU_CLASS;
    populateDropdownMenu(menu, options.terms, options.buildUrl);

    wrapper.appendChild(toggle);
    wrapper.appendChild(menu);
    applyDropdownTheme(wrapper);
    bindEmplinkDropdown(wrapper);
    return wrapper;
  }

  function upsertSiteControl(nameIcons, anchor, options) {
    const existing = nameIcons.querySelector(
      '[data-emplink-site="' + options.siteKey + '"]'
    );
    const isDropdown = options.terms.length > 1;

    if (!isDropdown) {
      const entry = options.terms[0];
      const linkOptions = {
        siteKey: options.siteKey,
        className: options.className,
        href: options.buildUrl(entry.term),
        title: options.titlePrefix + entry.term,
        iconSrc: options.iconSrc,
        iconClassName: options.iconClassName,
      };

      if (existing && existing.tagName === "A") {
        existing.href = linkOptions.href;
        existing.title = linkOptions.title;
        return existing;
      }

      if (existing) {
        existing.remove();
      }

      const link = createPerformerLink(linkOptions);
      anchor.insertAdjacentElement("afterend", link);
      return link;
    }

    if (existing && existing.classList.contains("emplink-site-dropdown")) {
      const toggle = existing.querySelector(".dropdown-toggle");
      const menu = existing.querySelector(".dropdown-menu");
      if (toggle) {
        toggle.title = options.title;
      }
      if (menu) {
        populateDropdownMenu(menu, options.terms, options.buildUrl);
      }
      applyDropdownTheme(existing);
      bindEmplinkDropdown(existing);
      return existing;
    }

    if (existing) {
      existing.remove();
    }

    const dropdown = createPerformerDropdown({
      siteKey: options.siteKey,
      terms: options.terms,
      buildUrl: options.buildUrl,
      className: options.className,
      iconSrc: options.iconSrc,
      iconClassName: options.iconClassName,
      title: options.title,
    });
    anchor.insertAdjacentElement("afterend", dropdown);
    return dropdown;
  }

  function removeSiteControl(nameIcons, siteKey) {
    const control = nameIcons.querySelector(
      '[data-emplink-site="' + siteKey + '"]'
    );
    if (control) {
      control.remove();
    }
  }

  async function injectPerformerLinks() {
    await loadSettings();

    const performerId = getPerformerIdFromPath();
    if (!performerId) {
      return false;
    }

    const searchTerms = await fetchPerformerSearchTerms(performerId);
    if (!searchTerms.length) {
      return false;
    }

    const nameIcons = document.querySelector("#performer-page .name-icons");
    if (!nameIcons) {
      return false;
    }

    const favoriteButton = nameIcons.querySelector(".favorite-button");
    if (!favoriteButton) {
      return false;
    }

    let anchor = favoriteButton;

    if (pluginConfig.showEmpLink) {
      anchor = upsertSiteControl(nameIcons, anchor, {
        siteKey: "emp",
        terms: searchTerms,
        buildUrl: buildEmpUrl,
        className: "emp-link-button",
        iconSrc: EMP_FAVICON,
        iconClassName: "emp-link-icon",
        titlePrefix: "Search Empornium for ",
        title: "Search Empornium",
      });
    } else {
      removeSiteControl(nameIcons, "emp");
    }

    if (pluginConfig.showBunkrLink) {
      upsertSiteControl(nameIcons, anchor, {
        siteKey: "bunkr",
        terms: searchTerms,
        buildUrl: buildBunkrUrl,
        className: "bunkr-link-button",
        iconSrc: BUNKR_FAVICON,
        iconClassName: "bunkr-link-icon",
        titlePrefix: "Search Bunkr albums for ",
        title: "Search Bunkr albums",
      });
    } else {
      removeSiteControl(nameIcons, "bunkr");
    }

    if (!pluginConfig.showEmpLink && !pluginConfig.showBunkrLink) {
      return true;
    }

    return pluginConfig.showEmpLink || pluginConfig.showBunkrLink;
  }

  function watchPerformerPage() {
    if (pageObserver) {
      pageObserver.disconnect();
    }

    const performerPage = document.querySelector("#performer-page");
    if (!performerPage) {
      return;
    }

    pageObserver = new MutationObserver(function () {
      if (!document.querySelector("#performer-page")) {
        removePerformerLinks();
        return;
      }
      injectPerformerLinks();
    });

    pageObserver.observe(performerPage, {
      childList: true,
      subtree: true,
    });
  }

  function scheduleInject() {
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = null;
    }

    let attempts = 0;

    function tryInject() {
      if (!document.querySelector("#performer-page")) {
        return;
      }

      injectPerformerLinks().then(function (success) {
        if (success) {
          watchPerformerPage();
          return;
        }

        attempts += 1;
        if (attempts < MAX_ATTEMPTS) {
          injectTimer = setTimeout(tryInject, RETRY_MS);
        }
      });
    }

    tryInject();
  }

  function onLocationChange(pathname) {
    const performerId = getPerformerIdFromPath(pathname);
    if (performerId) {
      if (cachedPerformerId !== performerId) {
        clearPerformerCache();
      }
      scheduleInject();
    } else {
      clearPerformerCache();
      removePerformerLinks();
    }
  }

  function refreshPerformerLinksIfVisible() {
    if (getPerformerIdFromPath()) {
      injectPerformerLinks();
    }
  }

  PluginApi.patch.before("PluginSettings", function (props) {
    if (props.pluginID !== PLUGIN_ID) {
      return [props];
    }

    return [{ ...props, settings: [] }];
  });

  PluginApi.patch.after("PluginSettings", function (props, _element) {
    if (props.pluginID !== PLUGIN_ID) {
      return _element;
    }

    function LinkConfigRow(rowProps) {
      const { label, enabledKey, urlKey } = rowProps;
      const { plugins, savePluginSettings } = PluginApi.hooks.useSettings();
      const current = migratePluginSettings(plugins[PLUGIN_ID] ?? {});

      function persist(nextSettings) {
        const migrated = migratePluginSettings(nextSettings);
        applyPluginSettings(migrated);
        savePluginSettings(PLUGIN_ID, migrated);
        refreshPerformerLinksIfVisible();
      }

      function onEnabledChange(event) {
        persist({
          ...current,
          [enabledKey]: event.currentTarget.checked,
        });
      }

      function onUrlChange(event) {
        persist({
          ...current,
          [urlKey]: event.currentTarget.value,
        });
      }

      return React.createElement(
        "div",
        { className: "emplink-settings-row" },
        React.createElement(
          "span",
          { className: "emplink-settings-label" },
          label
        ),
        React.createElement(
          "span",
          { className: "emplink-settings-enable" },
          React.createElement(Form.Check, {
            type: "checkbox",
            id: `plugin-${PLUGIN_ID}-${enabledKey}`,
            label: "Show",
            checked: current[enabledKey],
            onChange: onEnabledChange,
          })
        ),
        React.createElement(Form.Control, {
          type: "text",
          className: "text-input emplink-settings-url",
          id: `plugin-${PLUGIN_ID}-${urlKey}`,
          value: current[urlKey],
          onChange: onUrlChange,
          placeholder: "https://example.com",
        })
      );
    }

    function PluginSettingsPanel() {
      return React.createElement(
        "div",
        { className: "plugin-settings" },
        React.createElement(LinkConfigRow, {
          label: "Empornium",
          enabledKey: "showEmpLink",
          urlKey: "empBaseUrl",
        }),
        React.createElement(LinkConfigRow, {
          label: "Bunkr albums",
          enabledKey: "showBunkrLink",
          urlKey: "bunkrBaseUrl",
        })
      );
    }

    return React.createElement(PluginSettingsPanel);
  });

  PluginApi.Event.addEventListener("stash:location", function (e) {
    loadSettings().then(function () {
      onLocationChange(e.detail.data.location.pathname);
    });
  });

  loadSettings().then(function () {
    onLocationChange(window.location.pathname);
  });
})();
