import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  redirects() {
    return [
      { source: '/docs/byo-vps', destination: '/docs/computers/byo-vps', permanent: true },
      {
        source: '/docs/getting-started/using-the-desktop-app-with-my-cloud',
        destination: '/docs/getting-started/connect-to-a-server',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
