# 🎬 Auraflix Streaming UI

**Auraflix** is a premium, Netflix-inspired streaming platform interface built with pure HTML, CSS, and Vanilla JavaScript. This project focuses on high-fidelity UI/UX design, smooth animations, and real-time data integration using the **TMDB (The Movie Database) API** to replicate the immersive experience of a world-class video streaming service.

## 🌐 Live Demo
auraflixx.vercel.app

## ✨ Key Features

### 🎥 Immersive Hero Section
- **Dynamic Backdrops:** Full-screen hero banners fetched from TMDB, featuring gradient overlays for optimal text readability.
- **Call-to-Action:** Prominent "Play" and "More Info" buttons with premium hover effects.
- **Responsive Typography:** Scales perfectly from mobile devices to ultra-wide desktop screens.

### 🎞️ Dynamic Content Carousels
- **Real-Time Data:** Fetches trending movies, top-rated shows, and genre-specific content directly from the TMDB API.
- **Horizontal Scrolling:** Smooth, snap-based scrolling for movie and TV show rows.
- **Hover Previews:** Cards expand on hover to reveal ratings, release dates, and quick action buttons.

### 📱 Premium Responsive Design
- **Mobile-First Approach:** Fully optimized for touch interactions on smartphones and tablets.
- **Adaptive Grid:** Layout automatically adjusts column counts based on viewport width.
- **Navigation:** Collapsible hamburger menu for small screens, full sticky nav bar for desktop.

### 🎨 Modern UI/UX
- **Dark Mode Aesthetic:** Deep blacks (`#141414`) and vibrant red accent colors typical of premium streaming apps.
- **Modal Details:** Clicking a title opens a sleek overlay with synopsis, cast info, and similar titles.
- **Loading States:** Skeleton screens and spinners for a polished user experience during API fetches.

## 🛠️ Tech Stack
- **Core:** HTML5, CSS3, Vanilla JavaScript (ES6+)
- **API:** TMDB (The Movie Database) API for real-time movie/TV data
- **Styling:** Custom CSS3 (Flexbox, Grid, Transitions, Animations)
- **Deployment:** Vercel (configured via `vercel.json`)

## 📁 Project Structure
```text
├── index.html          # Main entry point and semantic structure
├── app.js              # Core logic (TMDB API calls, carousel rendering, modal handlers)
├── style.css           # Premium styling, animations, and responsive breakpoints
├── vercel.json         # Vercel deployment configuration
└── .gitignore          # Git ignore rules
