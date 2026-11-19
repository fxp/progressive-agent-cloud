export const WORKFLOW_PATH='.github/workflows/progressive-agent.yml';
export function workflow(){return `# Managed by Progressive Agent Connector v1
name: Progressive Agent
run-name: PA \${{ inputs.task_id }}
on:
  schedule:
    - cron: '2-59/5 * * * *'
  workflow_dispatch:
    inputs:
      task_id:
        required: true
        type: string
permissions:
  contents: read
concurrency:
  group: pa-\${{ inputs.task_id }}
  cancel-in-progress: false
jobs:
  wake:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - name: Sync meeting artifacts and advance the project queue
        env:
          PA_PLATFORM: \${{ secrets.PA_PLATFORM }}
          PA_BIGMODEL_KEY: \${{ secrets.PA_BIGMODEL_KEY }}
        run: node .github/progressive-agent/runner.mjs tick
  prepare:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 18
    outputs:
      base: \${{ steps.prepare.outputs.base }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Implement with selected Agent
        id: prepare
        env:
          PA_PLATFORM: \${{ secrets.PA_PLATFORM }}
          PA_BIGMODEL_KEY: \${{ secrets.PA_BIGMODEL_KEY }}
          PA_TASK_ID: \${{ inputs.task_id }}
          PA_AGENT_CONFIG: \${{ secrets.PA_AGENT_CONFIG }}
        run: node .github/progressive-agent/runner.mjs prepare
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        if: always()
        with:
          name: pa-change
          path: \${{ runner.temp }}/pa-change
          retention-days: 3
          if-no-files-found: error
  verify:
    needs: prepare
    runs-on: ubuntu-latest
    timeout-minutes: 12
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ needs.prepare.outputs.base }}
          path: project
          persist-credentials: false
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: pa-change
          path: \${{ runner.temp }}/pa-change
      - name: Validate proposed changes
        working-directory: project
        run: node ../.github/progressive-agent/runner.mjs verify
  publish:
    needs: [prepare, verify]
    runs-on: ubuntu-latest
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ needs.prepare.outputs.base }}
          path: project
          persist-credentials: false
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: pa-change
          path: \${{ runner.temp }}/pa-change
      - name: Create PR and backfill requirement
        working-directory: project
        env:
          PA_PLATFORM: \${{ secrets.PA_PLATFORM }}
          PA_TASK_ID: \${{ inputs.task_id }}
        run: node ../.github/progressive-agent/runner.mjs publish
`;}

