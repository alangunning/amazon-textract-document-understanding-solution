import React, { Fragment, useCallback, useEffect, useRef, useState, useMemo } from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { reject, either, isNil, isEmpty, groupWith } from 'ramda'
import queryString from 'query-string'
import cs from 'classnames'
import { Storage } from 'aws-amplify'

import Loading from '../../components/Loading/Loading'
import DocumentViewer from '../../components/DocumentViewer/DocumentViewer'
import SearchBar from '../../components/SearchBar/SearchBar'
import Tabs from '../../components/Tabs/Tabs'

import {
  fetchDocument,
  addRedactions,
  clearRedactions,
} from '../../store/entities/documents/actions'
import { getDocumentById } from '../../store/entities/documents/selectors'
import { setHeaderProps } from '../../store/ui/actions'
import { getSelectedTrackId } from '../../store/ui/selectors'
import { setCurrentPageNumber, setSearchQuery } from '../../store/entities/meta/actions'
import { getCleanSearchQuery, getCurrentPageNumber } from '../../store/entities/meta/selectors'

import {
  getDocumentPageCount,
  getPageLines,
  getDocumentLines,
  getDocumentKeyValuePairs,
  getPageTables,
  getPageWordsBySearch,
  countDocumentKeyValuePairs,
  countDocumentTables,
} from '../../utils/document'

import css from './view.scss'
import Button from '../../components/Button/Button'
import KeyValueList from '../../components/KeyValueList/KeyValueList'
import RawTextLines from '../../components/RawTextLines/RawTextLines'

Document.propTypes = {
  currentPageNumber: PropTypes.number,
  dispatch: PropTypes.func,
  document: PropTypes.object,
  id: PropTypes.string,
  pageTitle: PropTypes.string,
  searchQuery: PropTypes.string,
  track: PropTypes.string,
}

Document.defaultProps = {
  document: {},
}

Document.getInitialProps = function({ query, store }) {
  const state = store.getState()
  const { id } = query || {}
  const { documentName } = getDocumentById(state, id) || {}

  const props = {
    backHref: '/documents',
    backTitle: 'Collection',
    pageTitle: documentName,
  }

  return props
}

function Document({ currentPageNumber, dispatch, id, document, pageTitle, searchQuery, track }) {
  // TODO: Ensure id corresponds to a valid resource, otherwise 404
  // e.g. /documents/export and /documents/view should fail
  const isDocumentFetched = !!document.textractResponse
  const { status } = useFetchDocument(dispatch, id, isDocumentFetched)
  const pageCount = getDocumentPageCount(document)
  const { documentName, documentURL, searchablePdfURL } = document

  // Reset currentPageNumber on mount
  useEffect(() => {
    dispatch(setCurrentPageNumber(1))
  }, [dispatch])

  useEffect(() => {
    return () => {
      dispatch(clearRedactions(id))
    }
  }, [dispatch, id])

  // Set search results data
  const wordsMatchingSearch = useMemo(() => {
    return getPageWordsBySearch(document, currentPageNumber, searchQuery)
  }, [document, currentPageNumber, searchQuery])

  const docData = useMemo(() => {
    const pairs = getDocumentKeyValuePairs(document)
    const tables = countDocumentTables(document)
    const lines = getDocumentLines(document)

    return { pairs, tables, lines }
    // eslint-disable-next-line
  }, [document, document.textractResponse])

  // Set the paged content for each tab
  const pageData = useMemo(() => {
    const lines = getPageLines(document, currentPageNumber)
    const pairs = docData.pairs.filter(d => d.pageNumber === currentPageNumber)
    const tables = getPageTables(document, currentPageNumber)
    return { lines, pairs, tables }
    // eslint-disable-next-line
  }, [document, document.textractResponse, currentPageNumber, docData.pairs])

  const [tab, selectTab] = useState('search')

  // Update header props when we get a document response
  useEffect(() => {
    dispatch(
      setHeaderProps(
        reject(either(isNil, isEmpty), {
          heading: documentName,
        })
      )
    )

    return () => dispatch(setHeaderProps({}))
  }, [dispatch, documentName, pageTitle, track])

  const downloadKV = useCallback(async () => {
    const { resultDirectory } = document
    const url = await Storage.get(`${resultDirectory}page-${currentPageNumber}-forms.csv`, {
      expires: 300,
    })
    window.open(url)
  }, [currentPageNumber, document])

  const redactMatches = useCallback(async () => {
    dispatch(addRedactions(id, currentPageNumber, wordsMatchingSearch))
    dispatch(setSearchQuery(''))
  }, [currentPageNumber, dispatch, id, wordsMatchingSearch])

  const redact = useCallback(
    async (bbox, pageNumber = currentPageNumber) => {
      dispatch(addRedactions(id, pageNumber, [bbox]))
    },
    [currentPageNumber, dispatch, id]
  )

  const clearReds = useCallback(() => {
    dispatch(clearRedactions(id))
  }, [dispatch, id])

  const redactAllValues = useCallback(() => {
    dispatch(addRedactions(id, currentPageNumber, pageData.pairs.map(p => p.valueBoundingBox)))
  }, [currentPageNumber, dispatch, id, pageData.pairs])

  const contentRef = useRef()

  const downloadRedacted = useCallback(async () => {
    const theThing = contentRef.current.querySelector('canvas,img')

    const cnv = window.document.createElement('canvas')
    // TODO the resolution is just based on the viewport for pdfs. It shouldn't be.
    cnv.width = theThing.naturalWidth || theThing.width
    cnv.height = theThing.naturalHeight || theThing.height

    const ctx = cnv.getContext('2d')

    ctx.drawImage(theThing, 0, 0)

    ctx.fillStyle = '#000'
    const x = val => val * cnv.width
    const y = val => val * cnv.height
    const margin = 2

    Object.values(document.redactions[currentPageNumber]).forEach(red => {
      ctx.fillRect(
        x(red.Left) - margin,
        y(red.Top) - margin,
        x(red.Width) + 2 * margin,
        y(red.Height) + 2 * margin
      )
    })

    cnv.toBlob(blob => {
      const a = window.document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.target = '_blank'
      a.style.display = 'none'
      a.download = document.objectName
        .split('/')
        .pop()
        .replace(/\.[^.]+$/, '-REDACTED.png')
      window.document.body.appendChild(a)
      a.click()
    }, 'image/png')
  }, [currentPageNumber, document.objectName, document.redactions])

  const pagePairsAsMarks = useMemo(() => {
    return pageData.pairs.reduce((acc, { id, keyBoundingBox, valueBoundingBox }) => {
      return [
        ...acc,
        { ...keyBoundingBox, id, type: 'key' },
        { ...valueBoundingBox, id, type: 'value' },
      ]
    }, [])
  }, [pageData.pairs])

  const pageLinesAsMarks = useMemo(() => {
    return pageData.lines.map(({ id, boundingBox }) => {
      return {
        id,
        ...boundingBox,
      }
    })
  }, [pageData.lines])

  const [highlightedKv, setHighlightedKv] = useState(null)

  useEffect(() => {
    if (highlightedKv) {
      setTimeout(() => {
        setHighlightedKv(null)
      }, 10)
    }
  }, [highlightedKv])

  const switchPage = useCallback(
    pageNumber => {
      dispatch(setCurrentPageNumber(pageNumber))
    },
    [dispatch]
  )

  const setHighlightedLine = useCallback(() => {}, [])

  return (
    <div className={css.document}>
      {status === 'pending' && <Loading />}

      {status === 'success' && (
        <>
          <div className={css.tabWrapper}>
            <Tabs
              selected={tab}
              onSelectTab={selectTab}
              items={[
                { id: 'search', title: 'Overview' },
                { id: 'text', title: 'Raw Text' },
                { id: 'kv', title: `${docData.pairs.length} Key-Value Pairs` },
                { id: 'tables', title: `${docData.tables} Tables` },
              ]}
            />

            {track === 'redaction' &&
            document.redactions &&
            Object.keys(document.redactions).length ? (
              <div>
                <Button inverted onClick={clearReds}>
                  Clear Redaction
                </Button>
                <Button className={css.downloadRedacted} onClick={downloadRedacted}>
                  Download Redacted Version
                </Button>
              </div>
            ) : null}

            <div className={css.downloadButtons}>
              <Button
                inverted
                link={{ download: documentName.split('/').pop() }}
                href={documentURL}
              >
                Download Original
              </Button>

              {track === 'search' ? (
                <Button link={{ download: 'searchable-pdf.pdf' }} href={searchablePdfURL}>
                  Download Searchable PDF
                </Button>
              ) : null}
            </div>
          </div>
          <div className={cs(css.searchBarWrapper, tab === 'search' && css.visible)}>
            <SearchBar className={css.searchBar} />
            {track === 'redaction' ? <Button onClick={redactMatches}>Redact matches</Button> : null}
          </div>
          <div className={css.content} ref={contentRef}>
            <DocumentViewer
              className={cs(
                css.tabSourceViewer,
                tab === 'kv' && css.withKv,
                tab === 'text' && css.withText
              )}
              document={document}
              pageCount={pageCount}
              redactions={(document.redactions || {})[currentPageNumber]}
              marks={
                tab === 'search'
                  ? wordsMatchingSearch
                  : tab === 'text'
                  ? pageLinesAsMarks
                  : tab === 'kv'
                  ? pagePairsAsMarks
                  : []
              }
              tables={tab === 'tables' && pageData.tables}
              highlightedMark={highlightedKv}
            />

            <div
              className={cs(
                css.sidebar,
                (tab === 'kv' || tab === 'text') && css.visible,
                tab === 'text' && css.wide
              )}
            >
              <KeyValueList
                kvPairs={docData.pairs}
                pageCount={pageCount}
                currentPageNumber={currentPageNumber}
                showRedaction={track === 'redaction'}
                onHighlight={setHighlightedKv}
                onSwitchPage={switchPage}
                onRedact={redact}
                onRedactAll={redactAllValues}
                onDownload={downloadKV}
                visible={tab === 'kv'}
              />

              <RawTextLines
                lines={docData.lines}
                pageCount={pageCount}
                currentPageNumber={currentPageNumber}
                onHighlight={setHighlightedLine}
                onSwitchPage={switchPage}
                visible={tab === 'text'}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default connect(function mapStateToProps(state) {
  const { id } = queryString.parse(location.search)

  return {
    id,
    currentPageNumber: getCurrentPageNumber(state, id),
    document: getDocumentById(state, id),
    searchQuery: getCleanSearchQuery(state),
    track: getSelectedTrackId(state),
  }
})(Document)

/**
 * Conditionally fetch documents from the client side.
 *
 * @param {Function} dispatch Redux dispatch function
 * @param {Array} documents An array of documents
 * @param {Boolean} isDocumentFetched True if the document has already been fetched
 */
function useFetchDocument(dispatch, id, isDocumentFetched) {
  const isMounted = useRef(true)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!isDocumentFetched) {
      isMounted.current && setStatus('pending')

      dispatch(fetchDocument(id))
        .then(meta => {
          isMounted.current && setStatus('success')
        })
        .catch(() => {
          isMounted.current && setStatus('error')
        })
    } else {
      isMounted.current && setStatus('success')
    }
  }, [dispatch, id, isDocumentFetched])

  // Ensure we don't try to set state after component unmount
  useEffect(() => () => (isMounted.current = false), [])

  return { status }
}
