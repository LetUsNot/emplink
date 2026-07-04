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

  let injectTimer = null;
  let pageObserver = null;
  let pluginConfig = migratePluginSettings({});

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

  function getPerformerName() {
    const nameEl = document.querySelector("#performer-page span.performer-name");
    if (!nameEl) {
      return null;
    }
    return nameEl.textContent.trim() || null;
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
    document.querySelectorAll(".emp-link-button, .bunkr-link-button").forEach(function (el) {
      el.remove();
    });
  }

  function createPerformerLink(options) {
    const link = document.createElement("a");
    link.className = "btn minimal " + options.className;
    link.href = options.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = options.title;

    const img = document.createElement("img");
    img.src = options.iconSrc;
    img.alt = "";
    img.className = options.iconClassName;
    img.width = 16;
    img.height = 16;
    img.draggable = false;
    link.appendChild(img);

    return link;
  }

  function upsertLink(nameIcons, selector, anchor, createOptions) {
    let link = nameIcons.querySelector(selector);
    if (!link) {
      link = createPerformerLink(createOptions);
      anchor.insertAdjacentElement("afterend", link);
    } else {
      link.href = createOptions.href;
      link.title = createOptions.title;
    }
    return link;
  }

  function removeLink(nameIcons, selector) {
    const link = nameIcons.querySelector(selector);
    if (link) {
      link.remove();
    }
  }

  async function injectPerformerLinks() {
    await loadSettings();

    const performerName = getPerformerName();
    if (!performerName) {
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
      anchor = upsertLink(nameIcons, ".emp-link-button", anchor, {
        className: "emp-link-button",
        href: buildEmpUrl(performerName),
        title: "Search Empornium for " + performerName,
        iconSrc: EMP_FAVICON,
        iconClassName: "emp-link-icon",
      });
    } else {
      removeLink(nameIcons, ".emp-link-button");
    }

    if (pluginConfig.showBunkrLink) {
      upsertLink(nameIcons, ".bunkr-link-button", anchor, {
        className: "bunkr-link-button",
        href: buildBunkrUrl(performerName),
        title: "Search Bunkr albums for " + performerName,
        iconSrc: BUNKR_FAVICON,
        iconClassName: "bunkr-link-icon",
      });
    } else {
      removeLink(nameIcons, ".bunkr-link-button");
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
    if (/^\/performers\/\d+/.test(pathname)) {
      scheduleInject();
    } else {
      removePerformerLinks();
    }
  }

  function refreshPerformerLinksIfVisible() {
    if (/^\/performers\/\d+/.test(window.location.pathname)) {
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
