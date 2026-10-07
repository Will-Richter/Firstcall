# Firstcall Lead Desk

A leads app for a trade business. It collects website enquiries, lines them up newest first, and makes each one a tap away from a phone call.

Built for SunWise Solar Cleaning (Bundaberg, QLD).

## What it does

- Reads website form submissions (Squarespace "Form Submission" emails) from Gmail
- Shows each lead with name, suburb, phone, email, address, panel count, storeys, services wanted and message
- Call, text, email and map buttons on every lead
- Statuses: New, Contacted, Quoted, Successful, Unsuccessful, Archived
- After a call, asks how it went and updates the lead
- Groups repeat enquiries from the same person into one lead
- Notes and an activity log per lead
- Checks whether the person is already a ServiceM8 client, and creates a ServiceM8 job (and client) from the lead
- Search by name, suburb, phone or email; light and dark themes

## How it runs

`index.html` is the whole app: one file of HTML, CSS and JavaScript, no build step.

It is published as a Claude artifact and depends on Claude for three things:

| Needs | Used for |
|---|---|
| Gmail connector (`search_threads`, `get_thread`) | reading the form submission emails |
| ServiceM8 connector (`search`, `list_job_templates`, `create_job`) | client check and job creation |
| Artifact database | saving leads, statuses and notes |

Opened anywhere else (for example straight from this repository) the page loads but cannot reach Gmail, ServiceM8 or its saved data. A standalone version would need its own Google sign-in, a ServiceM8 API connection and its own storage.

The file is the page body as published: Claude wraps it in the `<!doctype html>` shell when publishing.

## Data

No customer data is stored in this repository. Leads live in the artifact's own database.
