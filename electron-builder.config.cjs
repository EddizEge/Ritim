const repository = process.env.RITIM_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || 'EddizEge/Ritim'
const [owner, repo] = repository.split('/')
const { version } = require('./package.json')
const { updateChannel } = require('./electron/version-policy.cjs')

module.exports = {
  appId: 'app.ritim.desktop',
  productName: 'Ritim',
  artifactName: 'Ritim-Setup-${version}.${ext}',
  // Capacitor packages are phone-only (bundled into dist/ by Vite for the
  // Android shell). A local 0.9.1-beta.1 build shipped them with Android
  // sources and build outputs, whose long paths later broke the old
  // uninstaller (build/installer.nsh). The desktop package never requires them.
  files: [
    'dist/**/*',
    'electron/**/*',
    'shared/**/*',
    'package.json',
    '!node_modules/@capacitor/**',
    '!node_modules/@capacitor-mlkit/**',
    // node-gyp intermediates (register-scheme, via discord-rpc) are not needed
    // at runtime and carry the longest paths of a local build.
    '!node_modules/**/build/Release/obj/**',
  ],
  directories: { output: process.env.RITIM_RELEASE_DIR || 'release' },
  win: { target: 'nsis', icon: 'build/icon.ico' },
  nsis: {
    oneClick: true,
    perMachine: false,
    include: 'build/installer.nsh',
  },
  publish: [{ provider: 'github', owner, repo, releaseType: 'release', channel: updateChannel(version) }],
  electronUpdaterCompatibility: '>=2.16',
}
