import type { MetadataRoute } from "next";

/**
 * Lets the suite be added to a phone's home screen, and (on Android) appear
 * in the phone's Share menu so photos and videos can be sent straight into a
 * workspace's Assets.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Maker Business Suite",
    short_name: "Maker Suite",
    description: "Money, customers, bookings and social for small maker businesses.",
    start_url: "/app",
    display: "standalone",
    background_color: "#f8f6f3",
    theme_color: "#213838",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    share_target: {
      action: "/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        files: [
          {
            name: "files",
            accept: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
          },
        ],
      },
    },
  };
}
