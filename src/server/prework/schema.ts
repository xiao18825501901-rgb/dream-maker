// DM-owned schema supplied by owner, adapted to original Engine resources; no astra-prep code.
export const handoffSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://dreammaker.local/schemas/dm-prework-handoff-v1.schema.json",
  "title": "Dream Maker Prework Handoff Contract v1",
  "description": "独立设计的DM交接合同草案；不是astra-prep上游schema的复制。",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "contractId",
    "projectId",
    "flowId",
    "planBinding",
    "sourceEpoch",
    "baseline",
    "planner2",
    "requirements",
    "workPackages",
    "reviewPlan",
    "evidencePolicy",
    "forecast",
    "status"
  ],
  "properties": {
    "schema": {
      "const": "dm.prework.handoff.v1"
    },
    "contractId": {
      "type": "string",
      "minLength": 8
    },
    "projectId": {
      "type": "string",
      "minLength": 1
    },
    "flowId": {
      "type": "string",
      "minLength": 1
    },
    "planBinding": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "planId",
        "version",
        "contentDigest",
        "approvedAt"
      ],
      "properties": {
        "planId": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "integer",
          "minimum": 1
        },
        "contentDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "approvedAt": {
          "type": "string",
          "format": "date-time"
        }
      }
    },
    "sourceEpoch": {
      "type": "string",
      "minLength": 8
    },
    "baseline": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "candidateId",
        "kind",
        "observedAt",
        "state"
      ],
      "properties": {
        "candidateId": {
          "type": "string",
          "minLength": 1
        },
        "kind": {
          "enum": [
            "git-tree",
            "source-snapshot",
            "project-artifact"
          ]
        },
        "commit": {
          "type": [
            "string",
            "null"
          ]
        },
        "tree": {
          "type": [
            "string",
            "null"
          ]
        },
        "snapshotRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "branch": {
          "type": [
            "string",
            "null"
          ]
        },
        "worktree": {
          "type": [
            "string",
            "null"
          ]
        },
        "observedAt": {
          "type": "string",
          "format": "date-time"
        },
        "state": {
          "enum": [
            "consistent",
            "drift-detected",
            "reconciled"
          ]
        },
        "reconciliationRef": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    },
    "planner2": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "role",
        "runtime",
        "sessionRef"
      ],
      "properties": {
        "role": {
          "const": "planner2"
        },
        "runtime": {
          "type": "string",
          "minLength": 1
        },
        "sessionRef": {
          "type": "string",
          "minLength": 1
        },
        "provenance": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "origin",
            "parentFlowId",
            "approvalRef",
            "approvalHash",
            "planRecordRef",
            "sessionRecordRef",
            "evidenceHash",
            "carriedTaskIds"
          ],
          "properties": {
            "origin": {
              "const": "INHERITED_NOT_NEW_PLANNING"
            },
            "parentFlowId": {
              "type": "string",
              "minLength": 1
            },
            "approvalRef": {
              "type": "string",
              "pattern": "^record:.+"
            },
            "approvalHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "planRecordRef": {
              "type": "string",
              "pattern": "^record:.+"
            },
            "sessionRecordRef": {
              "type": "string",
              "pattern": "^record:.+"
            },
            "evidenceHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "carriedTaskIds": {
              "type": "array",
              "uniqueItems": true,
              "items": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        }
      }
    },
    "requirements": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "requirementId",
          "planRequirementRef",
          "workPackageIds",
          "targetEvidence",
          "targetReview",
          "reachable",
          "acceptance"
        ],
        "properties": {
          "requirementId": {
            "type": "string",
            "minLength": 1
          },
          "planRequirementRef": {
            "type": "string",
            "minLength": 1
          },
          "workPackageIds": {
            "type": "array",
            "minItems": 1,
            "uniqueItems": true,
            "items": {
              "type": "string"
            }
          },
          "targetEvidence": {
            "enum": [
              "E1",
              "E2",
              "E3",
              "E4",
              "E5"
            ]
          },
          "targetReview": {
            "enum": [
              "R0",
              "R1",
              "R2"
            ]
          },
          "reachable": {
            "type": "boolean"
          },
          "gapDecision": {
            "enum": [
              "acquire",
              "rescope",
              "accept-as-open"
            ]
          },
          "gapReason": {
            "type": [
              "string",
              "null"
            ]
          },
          "acceptance": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string",
              "minLength": 1
            }
          },
          "coverage": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "allOf": [
          {
            "if": {
              "properties": {
                "reachable": {
                  "const": false
                }
              }
            },
            "then": {
              "required": [
                "gapDecision",
                "gapReason"
              ]
            }
          }
        ]
      }
    },
    "workPackages": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "workPackageId",
          "taskId",
          "dependsOn",
          "requirementIds",
          "readPaths",
          "writePaths",
          "denyPaths",
          "inputs",
          "outputs",
          "checks",
          "stopConditions",
          "retryPolicy",
          "mergePolicy",
          "resourceClaims"
        ],
        "properties": {
          "workPackageId": {
            "type": "string",
            "minLength": 1
          },
          "taskId": {
            "type": "string",
            "minLength": 1
          },
          "executorId": {
            "type": [
              "string",
              "null"
            ]
          },
          "dependsOn": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "uniqueItems": true
          },
          "requirementIds": {
            "type": "array",
            "minItems": 0,
            "items": {
              "type": "string"
            },
            "uniqueItems": true
          },
          "readPaths": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "writePaths": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "denyPaths": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "inputs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "outputs": {
            "type": "array",
            "minItems": 0,
            "items": {
              "type": "string"
            }
          },
          "checks": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string"
            }
          },
          "stopConditions": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "retryPolicy": {
            "enum": [
              "none",
              "safe-idempotent-only",
              "reconcile-before-retry"
            ]
          },
          "mergePolicy": {
            "enum": [
              "single-coordinator",
              "no-merge",
              "proposal-only"
            ]
          },
          "sharedResources": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "resourceClaims": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "authority",
              "executorSlots",
              "maxConcurrentTools"
            ],
            "properties": {
              "authority": {
                "enum": [
                  "ORIGINAL_ENGINE_DISPATCH",
                  "NO_NEW_DISPATCH_INHERITED_BASELINE"
                ]
              },
              "executorSlots": {
                "enum": [
                  0,
                  1,
                  2
                ]
              },
              "maxConcurrentTools": {
                "enum": [
                  0,
                  1
                ]
              }
            }
          },
          "inheritedBaseline": {
            "type": "boolean"
          }
        },
        "allOf": [
          {
            "if": {
              "properties": {
                "inheritedBaseline": {
                  "const": true
                }
              },
              "required": [
                "inheritedBaseline"
              ]
            },
            "then": {
              "properties": {
                "writePaths": {
                  "const": []
                },
                "outputs": {
                  "const": []
                },
                "readPaths": {
                  "const": []
                },
                "resourceClaims": {
                  "const": {
                    "authority": "NO_NEW_DISPATCH_INHERITED_BASELINE",
                    "executorSlots": 0,
                    "maxConcurrentTools": 0
                  }
                }
              }
            }
          },
          {
            "if": {
              "properties": {
                "inheritedBaseline": {
                  "const": false
                }
              },
              "required": [
                "inheritedBaseline"
              ]
            },
            "then": {
              "properties": {
                "requirementIds": {
                  "minItems": 1
                },
                "outputs": {
                  "minItems": 1
                },
                "resourceClaims": {
                  "properties": {
                    "authority": {
                      "const": "ORIGINAL_ENGINE_DISPATCH"
                    },
                    "executorSlots": {
                      "enum": [
                        1,
                        2
                      ]
                    },
                    "maxConcurrentTools": {
                      "const": 1
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    "reviewPlan": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "required",
        "targetIndependence",
        "reviewerRole",
        "coverage"
      ],
      "properties": {
        "required": {
          "type": "boolean"
        },
        "targetIndependence": {
          "enum": [
            "R0",
            "R1",
            "R2"
          ]
        },
        "reviewerRole": {
          "type": "string",
          "minLength": 1
        },
        "reviewerSessionRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "routeRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "bundleRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "receiptRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "resultRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "coverage": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "targetIndependence": {
                "const": "R2"
              }
            }
          },
          "then": {
            "required": [
              "reviewerSessionRef",
              "routeRef",
              "bundleRef",
              "receiptRef",
              "resultRef"
            ]
          }
        }
      ]
    },
    "evidencePolicy": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "immutableOutputs",
        "controlCopies",
        "artifactRoot"
      ],
      "properties": {
        "immutableOutputs": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "artifact",
              "writer",
              "strategy"
            ],
            "properties": {
              "artifact": {
                "type": "string"
              },
              "writer": {
                "type": "string"
              },
              "strategy": {
                "enum": [
                  "unique-run-path",
                  "append-only",
                  "copy-before-rerun"
                ]
              }
            }
          }
        },
        "controlCopies": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "ref",
              "verifiedBeforeUse",
              "executionAfterVerification"
            ],
            "properties": {
              "ref": {
                "type": "string"
              },
              "verifiedBeforeUse": {
                "type": "boolean"
              },
              "executionAfterVerification": {
                "type": "boolean"
              }
            }
          }
        },
        "artifactRoot": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "forecast": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "bestReachableEvidence",
        "disclosures"
      ],
      "properties": {
        "bestReachableEvidence": {
          "enum": [
            "E1",
            "E2",
            "E3",
            "E4",
            "E5"
          ]
        },
        "disclosures": {
          "type": "array",
          "items": {
            "enum": [
              "baseline-drift",
              "runtime-not-planned",
              "independent-review-unavailable",
              "transport-unverified",
              "capability-gap",
              "scope-confirmation-required",
              "evidence-retention-risk"
            ]
          }
        }
      }
    },
    "status": {
      "enum": [
        "draft",
        "validating",
        "ready-for-dispatch",
        "blocked",
        "stale",
        "cancelled"
      ]
    },
    "createdAt": {
      "type": "string",
      "format": "date-time"
    },
    "supersedesContractId": {
      "type": [
        "string",
        "null"
      ]
    }
  }
} as const;
