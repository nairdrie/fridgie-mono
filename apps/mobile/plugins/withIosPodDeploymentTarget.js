const { withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const MARKER = '# Fridgie: keep generated pods compatible with the current Xcode toolchain.';

/**
 * Newer Xcode versions reject dependency/resource targets whose inherited
 * deployment target is below the SDK-supported range. Apple clang 21 also
 * rejects fmt 11.0.2's C++20 consteval implementation (fmtlib/fmt#4740), which
 * is the version pinned by this React Native release. Building that pod itself
 * as C++17 disables the broken path without patching vendored source or changing
 * the C++20 setting used by React Native. Expo owns the generated Podfile, so
 * keep both reproducible adjustments in an idempotent post-install block.
 */
module.exports = function withIosPodDeploymentTarget(config) {
  return withDangerousMod(config, ['ios', async next => {
    const podfilePath = path.join(next.modRequest.platformProjectRoot, 'Podfile');
    const podfile = await fs.readFile(podfilePath, 'utf8');
    if (podfile.includes(MARKER)) return next;

    const anchor = '    # This is necessary for Xcode 14, because it signs resource bundles by default';
    if (!podfile.includes(anchor)) {
      throw new Error('Could not find the generated Podfile post_install anchor.');
    }
    const block = [
      `    ${MARKER}`,
      "    minimum_ios = Gem::Version.new('15.1')",
      '    installer.pods_project.targets.each do |pod_target|',
      '      pod_target.build_configurations.each do |build_config|',
      "        current = Gem::Version.new(build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] || '0')",
      "        build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum_ios.to_s if current < minimum_ios",
      "        next unless pod_target.name == 'fmt'",
      "        build_config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'",
      '      end',
      '    end',
      '',
    ].join('\n');
    await fs.writeFile(podfilePath, podfile.replace(anchor, `${block}${anchor}`));
    return next;
  }]);
};
