# Omoeba spec

## Goal

Manage a local library of PDFs.
PDFs can have inline annotations, Markdown note, tags, summaries associated with them.

## File format

Annotations are saved in .skim file along the PDF file.
Everything else (Markdown, tags, summaries) are saved in .json file along the PDF file.
The .json file is also used to store where the file was downloaded from.

## Settings

The first time the app is used, the user specifies one or more folders to track.
This is saved in ~/omoeba/config.json.
It's possible to add more folders later.
The settings also lists which AIs are authorized.

## AI

Use only AIs with a CLI interface.

## Paper list

This is the main page shown when opening up the app.

Each row in the paper list table shows:
- title
- authors (truncated if list is too long)
- folder
- tags

A reverse index is synchronized from time to time to easily be able to
search from tags, keywords, authors, and institutions.
This is down in the background to not block the app.

## Paper view

When clicking on a paper in the list, we are first shown a page containing:
- title
- authors
- institution
- summary
- original download location
- link/button to PDF reader

A paper can have multiple summaries (once per AI).
The summaries can contain Markdown and images.
The images are stored in base64 so that we can store them in the .json file directly.

If these are not available yet, AI is used to extract these pieces of information.
The .json file is then used as a cache.

If the PDF is missing, we use the original download location specified in the .json file to attempt to redownload the file.

## PDF reader

The main view is the PDF.
The left sidepane can show either thumbnails or table of contents.
The right sidepane can show either "Ask AI", Annotations or Notes.
Annotations are compatible with .skim file format.
Notes support Markdown rendering and LaTeX equations.
The top bar shows buttons to toggle the left side pane and the right side pane.

## Software stack

- Electron
- Typescript
- pdf.js
- KaTeX

## Logo

The letter O in Omoeba will be a spiral, potentially an ammonite shell.
This symbolizes the knowledge spiral.
Make the icon look cartoonish / cute.
Implement the logi in SVG and convert it to PNG too.