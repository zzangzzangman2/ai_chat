/** @type {import('next').NextConfig} */
const nextConfig = {
  // 좌하단 N(개발 인디케이터) 숨김
  devIndicators: false,
  experimental: {
    proxyClientMaxBodySize: "50mb",
  },
};

module.exports = nextConfig;
