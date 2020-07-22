const babel = require('quiq-scripts/config/babel');

module.exports = api => {
  const config = babel(api);
  config.presets = [
    [
      '@babel/preset-env',
      {
        loose: false,
        modules: false,
        targets: {
          browsers: ['Chrome >= 50', 'Edge >= 12', 'FF >= 45', 'Safari >= 9', 'IE >= 11'],
        },
        useBuiltIns: false,
      },
    ],
    '@babel/preset-typescript',
  ];

  return config;
};
