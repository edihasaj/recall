import AppKit
import SwiftUI

struct UpdatesTab: View {
    @ObservedObject var updates: UpdateController
    let onInstall: () -> Void

    private let amber = Color(red: 0.98, green: 0.71, blue: 0.36)

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Label(updates.isAvailable ? "UPDATE READY" :
                          (updates.latestVersion == nil ? "CHECK RELEASES" : "RECALL IS CURRENT"),
                          systemImage: updates.isAvailable ? "arrow.down.circle.fill" :
                          (updates.latestVersion == nil ? "arrow.clockwise.circle.fill" : "checkmark.circle.fill"))
                        .font(.custom("AvenirNext-DemiBold", size: 11))
                        .tracking(1.6)
                        .foregroundStyle(amber)
                    Spacer()
                    Text("RECALL / UPDATES")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .tracking(1)
                        .foregroundStyle(.white.opacity(0.48))
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(updates.isAvailable ? "A new Recall is ready." :
                         (updates.latestVersion == nil ? "Let's check for updates." : "You're up to date."))
                        .font(.custom("AvenirNext-Bold", size: 30))
                        .foregroundStyle(.white)
                    Text(updates.isAvailable
                         ? "Install the latest release here. Your local memories stay in place."
                         : (updates.latestVersion == nil
                            ? "Recall will show a release here once it can reach the update service."
                            : "We'll let you know when the next complete release arrives."))
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.78))
                }

                HStack(spacing: 10) {
                    versionPill("v\(updates.installedVersion)", prominent: false)
                    if updates.isAvailable, let latest = updates.latestVersion {
                        Image(systemName: "arrow.right")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white.opacity(0.55))
                        versionPill("v\(latest)", prominent: true)
                    }
                    Spacer()
                }

                HStack(spacing: 10) {
                    if updates.isAvailable {
                        Button(action: onInstall) {
                            Label(updates.canInstallInApp ? "Install & Restart" : "Download Update",
                                  systemImage: updates.canInstallInApp ? "arrow.down.to.line" : "arrow.up.right.square")
                                .font(.system(size: 13, weight: .semibold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(amber)
                        .controlSize(.large)
                        .disabled(updates.installing)
                    } else {
                        Button {
                            Task { await updates.check(force: true) }
                        } label: {
                            Label("Check Again", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(amber)
                        .controlSize(.large)
                        .disabled(updates.checking || updates.installing)
                    }

                    if let releaseURL = updates.releaseURL, updates.isAvailable {
                        Button("What's New") { NSWorkspace.shared.open(releaseURL) }
                            .controlSize(.large)
                    }
                    Spacer()
                }
            }
            .padding(26)
            .background {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(LinearGradient(
                        colors: [Color(red: 0.08, green: 0.31, blue: 0.32),
                                 Color(red: 0.06, green: 0.12, blue: 0.17)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ))
                    .overlay(alignment: .topTrailing) {
                        Circle()
                            .fill(amber.opacity(0.14))
                            .frame(width: 240, height: 240)
                            .blur(radius: 54)
                            .offset(x: 55, y: -85)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(amber.opacity(0.22), lineWidth: 1)
                    }
            }

            if updates.installing || updates.checking {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(updates.installing ? updates.phase : "Checking the latest release…")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }

            if let lastError = updates.lastError {
                InlineNotice(text: lastError, systemImage: "exclamationmark.triangle.fill", color: .orange)
                if FileManager.default.fileExists(atPath: updates.logPath) {
                    Button("Open Update Log") { updates.openLog() }
                        .controlSize(.small)
                }
            }

            HStack(spacing: 10) {
                Image(systemName: "lock.shield")
                    .foregroundStyle(.secondary)
                Text(updates.canInstallInApp
                     ? "Homebrew verifies the download. Recall reopens after the app and daemon update."
                     : "This copy isn't managed by Homebrew. Download the release to update it.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func versionPill(_ version: String, prominent: Bool) -> some View {
        Text(version)
            .font(.system(size: 13, weight: .semibold, design: .monospaced))
            .foregroundStyle(prominent ? Color.black : Color.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(prominent ? amber : Color.white.opacity(0.13), in: Capsule())
    }
}

struct UpdateNotice: View {
    @ObservedObject var updates: UpdateController

    var body: some View {
        if updates.isAvailable, let latest = updates.latestVersion {
            Button {
                NotificationCenter.default.post(name: .recallOpenUpdates, object: nil)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(Color(red: 0.98, green: 0.71, blue: 0.36))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Recall v\(latest) is ready")
                            .font(.system(size: 13, weight: .semibold))
                        Text("Install the update without leaving Recall")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "arrow.right")
                        .foregroundStyle(.secondary)
                }
                .padding(15)
                .background(Color(red: 0.98, green: 0.71, blue: 0.36).opacity(0.10),
                            in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }
}
