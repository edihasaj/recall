#!/usr/bin/env ruby
# frozen_string_literal: true
require "yaml"
require "open3"
require "tmpdir"
require "fileutils"

ROOT = File.expand_path("..", __dir__)
remote, status = Open3.capture2("git", "-C", ROOT, "config", "--get", "remote.origin.url")
raise "repository identity unavailable" unless status.success?
REPOSITORY = remote.strip[/github\.com[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/, 1]
raise "repository identity invalid" unless REPOSITORY

def condition(expression, context)
  source = (expression || "true").strip.sub(/\A\$\{\{\s*/, "").sub(/\s*\}\}\z/, "")
  source = source.gsub(/\b(?:github|inputs|needs|matrix)(?:\.[A-Za-z0-9_-]+)+/) do |reference|
    parts = reference.split(".")
    value = parts.reduce(context) { |item, key| item.is_a?(Hash) ? item[key] : nil }
    value = "success" if parts.first == "needs" && parts.last == "result"
    value.inspect
  end
  source = source.gsub(/\b(always|success)\(\)/, "true").gsub(/\b(cancelled|failure)\(\)/, "false")
  tokens = source.scan(/\s+|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|\b(?:true|false|nil|startsWith)\b|==|!=|&&|\|\||!|\(|\)|,/ )
  raise "unsupported cost guard #{expression.inspect}" unless tokens.join == source
  !!eval(source)
end

def startsWith(value, prefix)
  value.to_s.start_with?(prefix)
end

count = 0
Dir.glob(File.join(ROOT, ".github/workflows/*.{yml,yaml}")).each do |path|
  document = YAML.safe_load(File.read(path), aliases: true)
  next unless document.is_a?(Hash)
  triggers = document[true] || document["on"] || {}
  schema = triggers.is_a?(Hash) ? triggers.dig("workflow_dispatch", "inputs") || {} : {}
  defaults = schema.transform_values { |input| input["default"] }
  document.fetch("jobs", {}).each do |name, job|
    runner = job["runs-on"]
    matrix = job.dig("strategy", "matrix")
    labels = [runner, matrix].join(" ")
    next unless labels.match?(/macos|xcode/i)
    count += 1
    context = {"github" => {"repository" => REPOSITORY, "event_name" => "workflow_dispatch", "ref" => "refs/heads/production", "ref_name" => "production", "base_ref" => "production", "actor" => "owner", "ref_protected" => true, "event" => {"inputs" => defaults}}, "inputs" => defaults, "needs" => {}}
    scenarios = %w[push pull_request schedule merge_group workflow_run].product(%w[refs/heads/main refs/heads/production refs/tags/v9.9.9]).map { |event, ref| [event, ref, {}] }
    scenarios += %w[refs/heads/main refs/heads/production refs/tags/v9.9.9].map { |ref| ["workflow_dispatch", ref, defaults] }
    opt_in = defaults.merge("run_native" => true, "native_diagnostics" => true, "publish" => true, "platform" => "all", "preflight_only" => false)
    scenarios += %w[refs/heads/main refs/heads/feature refs/tags/v9.9.9].map { |ref| ["workflow_dispatch", ref, opt_in] }
    scenarios.each do |event, ref, inputs|
      context["github"].merge!("event_name" => event, "ref" => ref, "ref_name" => ref.split("/").last)
      context["inputs"] = inputs
      raise "#{File.basename(path)}/#{name} allocates a Mac for #{event} #{ref}" if condition(job["if"], context)
    end
    context["github"].merge!("event_name" => "workflow_dispatch", "ref" => "refs/heads/production", "ref_name" => "production")
    context["inputs"] = opt_in
    possible = [true, false].any? { |publish| context["inputs"] = opt_in.merge("publish" => publish); condition(job["if"], context) }
    raise "#{name} lost its explicit production path" unless possible
  end
end

validator = File.join(ROOT, "scripts/validate-production-release.sh")
if File.file?(validator)
  Dir.mktmpdir("production-release-contract-") do |dir|
    git = ->(*args) { output, result = Open3.capture2e("git", "-C", dir, *args); raise output unless result.success?; output.strip }
    git.call("init", "-q"); git.call("config", "user.email", "test@example.invalid"); git.call("config", "user.name", "Policy Test")
    git.call("commit", "--allow-empty", "-qm", "production")
    sha = git.call("rev-parse", "HEAD"); git.call("update-ref", "refs/remotes/origin/production", sha); git.call("tag", "-a", "v1.2.3", "-m", "production")
    check = ->(tag, ref, revision) { Open3.capture2e({"RELEASE_TAG" => tag, "GITHUB_REF" => ref, "GITHUB_SHA" => revision, "GITHUB_OUTPUT" => File.join(dir, "outputs")}, "bash", validator, chdir: dir).last.success? }
    raise "exact production tag rejected" unless check.call("v1.2.3", "refs/heads/production", sha)
    [["v1.2.3", "refs/heads/main", sha], ["v9.9.9", "refs/heads/production", sha], ["$(touch injected)", "refs/heads/production", sha], ["v1.2.3", "refs/heads/production", "0" * 40]].each do |arguments|
      raise "invalid release identity accepted" if check.call(*arguments)
    end
    git.call("commit", "--allow-empty", "-qm", "next"); git.call("update-ref", "refs/remotes/origin/production", git.call("rev-parse", "HEAD"))
    raise "stale production tag accepted" if check.call("v1.2.3", "refs/heads/production", sha)
  end
end
puts "CI cost policy passed: #{count} native jobs, no automatic/default Mac allocation; production identity checked."

if REPOSITORY == "edihasaj/vmlab"
  document = YAML.safe_load(File.read(File.join(ROOT, ".github/workflows/release.yml")), aliases: true)
  raise "VMLab cross-builds must stay on Linux" unless document.dig("jobs", "goreleaser", "runs-on") == "ubuntu-24.04"
  raise "VMLab release must be manual-only" unless document.fetch(true).keys == ["workflow_dispatch"]
end
if REPOSITORY == "edihasaj/foretype"
  document = YAML.safe_load(File.read(File.join(ROOT, ".github/workflows/release.yml")), aliases: true)
  raise "Foretype upload must stay on Linux" unless document.dig("jobs", "publish", "runs-on") == "ubuntu-24.04"
  raise "Foretype upload must retain approval" unless document.dig("jobs", "publish", "environment") == "production"
end
