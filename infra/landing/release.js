/**
 * Release asset resolution for the landing page.
 *
 * Pure on purpose: no DOM and no network, so the page and the tests share one
 * table of installers. The page passes a release object from the GitHub API and
 * the platform the visitor reports; everything else is a lookup.
 */
/**
 * One entry per download we publish, in the order the page prefers them.
 * `patterns` are tried in order, so a renamed artifact only needs an extra
 * entry rather than a change to the resolver.
 */
export const TARGETS = [
  {
    os: "windows",
    arch: "x64",
    label: "Windows 10/11",
    note: "Installer (.exe)",
    patterns: [/^MaiaLLM-Setup-\d+\.\d+\.\d+-(?:x64|amd64)\.exe$/i],
  },
  {
    os: "macos",
    arch: "arm64",
    label: "macOS",
    note: ".dmg",
    patterns: [/^MaiaLLM-\d+\.\d+\.\d+-arm64\.dmg$/i],
  },
  {
    os: "macos",
    arch: "x64",
    label: "macOS",
    note: ".dmg",
    patterns: [/^MaiaLLM-\d+\.\d+\.\d+-x64\.dmg$/i],
  },
  {
    os: "linux",
    arch: "x64",
    label: "Linux",
    note: "AppImage",
    patterns: [
      /^MaiaLLM-\d+\.\d+\.\d+-x64\.AppImage$/i,
      /^MaiaLLM-\d+\.\d+\.\d+-amd64\.AppImage$/i,
    ],
  },
  {
    os: "linux",
    arch: "arm64",
    label: "Linux",
    note: "AppImage",
    patterns: [/^MaiaLLM-\d+\.\d+\.\d+-arm64\.AppImage$/i],
  },
];

const OS_ALIASES = {
  win32: "windows",
  windows: "windows",
  win: "windows",
  darwin: "macos",
  mac: "macos",
  macos: "macos",
  macintel: "macos",
  linux: "linux",
};

const ARCH_ALIASES = {
  x64: "x64",
  x86_64: "x64",
  amd64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
};

export function normaliseOs(os) {
  if (!os) {
    return null;
  }

  return OS_ALIASES[String(os).toLowerCase()] || null;
}

export function normaliseArch(arch) {
  if (!arch) {
    return null;
  }

  return ARCH_ALIASES[String(arch).toLowerCase()] || null;
}

export function targetFor(os, arch) {
  var wantedOs = normaliseOs(os);
  var wantedArch = normaliseArch(arch);
  if (!wantedOs || !wantedArch) {
    return null;
  }

  return (
    TARGETS.filter(function (target) {
      return target.os === wantedOs && target.arch === wantedArch;
    })[0] || null
  );
}

/** Every platform/architecture pair the page offers in its selectors. */
export function targets() {
  return TARGETS.map(function (target) {
    return {
      os: target.os,
      arch: target.arch,
      label: target.label,
      note: target.note,
      archLabel: archLabel(target.os, target.arch),
    };
  });
}

function versionOf(name) {
  var match = /(\d+)\.(\d+)\.(\d+)/.exec(name || "");
  if (!match) {
    return [0, 0, 0];
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionsDescending(left, right) {
  var a = versionOf(left.name);
  var b = versionOf(right.name);
  for (var index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return b[index] - a[index];
    }
  }

  return 0;
}

/**
 * The installer for one platform, or null when the release does not carry it.
 * When several assets match, the highest version wins: a release can hold a
 * re-uploaded build without the page picking the older one.
 */
export function resolveAsset(release, os, arch) {
  var target = targetFor(os, arch);
  if (!target || !release || !Array.isArray(release.assets)) {
    return null;
  }

  var matches = release.assets.filter(function (asset) {
    if (!asset || !asset.name || !asset.browser_download_url) {
      return false;
    }

    return target.patterns.some(function (pattern) {
      return pattern.test(asset.name);
    });
  });

  if (matches.length === 0) {
    return null;
  }

  return matches.sort(compareVersionsDescending)[0];
}

export function formatSize(bytes) {
  if (typeof bytes !== "number" || !isFinite(bytes) || bytes <= 0) {
    return null;
  }

  var megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1024) {
    return Math.round(megabytes / 1024) + " GB";
  }

  return Math.max(1, Math.round(megabytes)) + " MB";
}

export function archLabel(os, arch) {
  var normalisedArch = normaliseArch(arch);
  if (normaliseOs(os) === "macos") {
    return normalisedArch === "arm64" ? "Apple silicon" : "Intel";
  }

  return normalisedArch === "arm64" ? "arm64" : "x64";
}

/**
 * What the download button should show for one visitor. `available: false`
 * means the selectors must say so instead of linking to a build that does not
 * exist yet.
 */
export function describeDownload(release, os, arch) {
  var normalisedOs = normaliseOs(os);
  var normalisedArch = normaliseArch(arch);
  var target = targetFor(normalisedOs, normalisedArch);

  if (!target) {
    return {
      available: false,
      reason: "unsupported-platform",
      os: normalisedOs,
      arch: normalisedArch,
    };
  }

  var asset = resolveAsset(release, normalisedOs, normalisedArch);
  if (!asset) {
    return {
      available: false,
      reason: "missing-asset",
      os: normalisedOs,
      arch: normalisedArch,
      label: target.label,
      note: target.note,
      fallbackUrl: release && release.html_url ? release.html_url : null,
    };
  }

  return {
    available: true,
    os: normalisedOs,
    arch: normalisedArch,
    url: asset.browser_download_url,
    label: target.label,
    note: target.note,
    archLabel: archLabel(normalisedOs, normalisedArch),
    sizeLabel: formatSize(asset.size),
    // Never printed with a version number: the link is re-resolved on load.
      caption: target.label + " " + archLabel(normalisedOs, normalisedArch),
  };
}

/**
 * Best guess for the visitor's platform. Detection is a convenience: the
 * selectors always let them correct it, and an unknown user agent falls back
 * to the build that has existed the longest.
 */
export function detectPlatform(input) {
  var userAgent = (input && input.userAgent) || "";
  var platform = (input && input.platform) || "";
  var haystack = userAgent + " " + platform;
  var os = null;

  if (/android|iphone|ipad|ipod/i.test(haystack)) {
    return { os: null, arch: null, supported: false };
  }

  if (/mac/i.test(haystack)) {
    os = "macos";
  } else if (/linux|x11|cros/i.test(haystack)) {
    os = "linux";
  } else if (/win/i.test(haystack)) {
    os = "windows";
  }

  if (!os) {
    return { os: "windows", arch: "x64", supported: true, fallback: true };
  }

  if (os === "macos") {
    // Browsers do not expose the chip: every Mac shipped since 2021 is Apple
    // silicon, so that is the better first guess.
    return { os: "macos", arch: "arm64", supported: true };
  }

  return { os: os, arch: "x64", supported: true };
}
