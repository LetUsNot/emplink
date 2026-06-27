(function () {
  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.warn("[emplink] PluginApi not available");
    return;
  }

  const EMP_FAVICON = "/plugin/emplink/assets/favicon.ico";
  const MAX_ATTEMPTS = 40;
  const RETRY_MS = 250;

  let injectTimer = null;
  let pageObserver = null;

  function buildEmpUrl(performerName) {
    const ename = performerName.replace(" ", ".");
    return (
      "https://www.empornium.sx/torrents.php" +
      "?order_by=snatched" +
      "&order_way=desc" +
      "&filter_freeleech=1" +
      "&taglist=" +
      encodeURIComponent(ename)
    );
  }

  function getPerformerName() {
    const nameEl = document.querySelector("#performer-page span.performer-name");
    if (!nameEl) {
      return null;
    }
    return nameEl.textContent.trim() || null;
  }

  function removeEmpLink() {
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = null;
    }
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    document.querySelectorAll(".emp-link-button").forEach(function (el) {
      el.remove();
    });
  }

  function createEmpLink(performerName) {
    const link = document.createElement("a");
    link.className = "btn minimal emp-link-button";
    link.href = buildEmpUrl(performerName);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Search Empornium for " + performerName;

    const img = document.createElement("img");
    img.src = EMP_FAVICON;
    img.alt = "";
    img.className = "emp-link-icon";
    img.width = 16;
    img.height = 16;
    img.draggable = false;
    link.appendChild(img);

    return link;
  }

  function injectEmpLink() {
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

    let link = nameIcons.querySelector(".emp-link-button");
    if (!link) {
      link = createEmpLink(performerName);
      favoriteButton.insertAdjacentElement("afterend", link);
    } else {
      link.href = buildEmpUrl(performerName);
      link.title = "Search Empornium for " + performerName;
    }

    return true;
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
        removeEmpLink();
        return;
      }
      injectEmpLink();
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

      if (injectEmpLink()) {
        watchPerformerPage();
        return;
      }

      attempts += 1;
      if (attempts < MAX_ATTEMPTS) {
        injectTimer = setTimeout(tryInject, RETRY_MS);
      }
    }

    tryInject();
  }

  function onLocationChange(pathname) {
    if (/^\/performers\/\d+/.test(pathname)) {
      scheduleInject();
    } else {
      removeEmpLink();
    }
  }

  PluginApi.Event.addEventListener("stash:location", function (e) {
    onLocationChange(e.detail.data.location.pathname);
  });

  onLocationChange(window.location.pathname);
})();
