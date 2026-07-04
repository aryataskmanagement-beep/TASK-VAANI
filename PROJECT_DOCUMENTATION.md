# ARYAASSOCIATES Task Management System - Project Documentation

## Project Overview
This is a full-stack task management application built with React, TypeScript, and Tailwind CSS. It is designed to manage business tasks, team assignments, and client reporting for ARYAASSOCIATES.

## Key Features

### 1. Dashboard & Stats
- **Stats Overview**: Displays "Total Tasks Done" and "Pending Tasks".
- **Today's Focus**: A dedicated modal showing tasks due for the current day (Weekly, Monthly, or Yearly).
- **Analog Clock**: A custom-designed wooden-style analog clock with Roman numerals.
- **Dynamic Greeting**: Personalized welcome messages based on the logged-in user.

### 2. User Roles & Access Control
- **ADMIN**: Full access to all features, including Master Table, Settings (Password changes), and all business data.
- **TEAM**: Can manage tasks for assigned businesses, start/end work sessions, and upload selfies.
- **BUSINESS (Client)**: 
    - Login via PAN Number and Password.
    - Restricted view: Can only see their own business data.
    - Hidden features: Master Table and Dashboard Filters (Search/Team) are hidden.
    - Restricted History: Can only see and export (PDF) their own completion history. Excel export is disabled for clients.

### 3. Task Management
- **Weekly Tasks**: Recurring tasks based on the day of the week.
- **Monthly Tasks**: Tasks due on specific dates of the month.
- **Yearly Tasks**: Tasks due in specific months.
- **Status Tracking**: Tasks can be set to PENDING, IN PROGRESS, DONE, or N/A.

### 4. Master Table
- **Business Master**: Manage business details (PAN, GST, Contact, assigned Team Member, etc.).
- **Team Master**: Manage team member details and contact information.
- **Column Management**: Admin can add, remove, or reorder columns in the Business Master table.
- **Search**: Real-time search functionality to find businesses or team members quickly.
- **Import/Export (Admin Only)**: 
    - **Import**: Upload Excel files to bulk-add or update records.
    - **Export**: Download records as Excel or PDF.
    - **Share**: Send records via Email or WhatsApp.
- **Document Management**: 
    - **Business Folders**: Each business has a dedicated "Working Papers" folder.
    - **File Upload**: Admins and Team members can upload PDFs, Images, and Excel files.
    - **WhatsApp Sharing**: Direct file sharing to WhatsApp and other apps using the Web Share API.

### 5. History & Reporting
- **History Log**: Records every task completion with timestamps, member name, and work session details.
    - **WhatsApp Sharing**: Share the entire History Log report (Excel or PDF) directly to WhatsApp from the log header.
- **Exports**: Support for Excel and PDF downloads (filtered by user role).
- **Auto-Reporting**: Simulated weekly history reports sent to a configured email.

### 6. Work Sessions
- **Check-in/Out**: Team members can record start and end times for tasks.
- **Selfie Verification**: Option to upload a selfie during a work session for accountability.

### 7. File Management
- **Working Papers**: Upload and manage documents for each business.
- **Pending Papers**: Track missing or required documents.

## Major Development Milestones (Conversation Summary)
- **Initial Setup**: Core dashboard and task grid implementation.
- **Role Implementation**: Added Admin, Team, and Business login flows.
- **Security Hardening**: 
    - Restricted Business users to only see their own data.
    - Hidden Master Table and Filters for clients.
    - Protected Master Table view from direct access by clients.
- **UI/UX Refinement**: 
    - Added custom Analog Clock.
    - Improved modal designs and responsive layouts.
    - Implemented "Today's Focus" filtering for specific users.
- **Export Features**: Added Excel and PDF export functionality with role-based filtering.

---
*Generated on: 2026-04-05*
